import {
  type Client,
  type LedgerEntry,
  type MPTokenMetadata,
  type TransactionMetadata,
  type Wallet,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  validateMPTokenMetadata,
} from 'xrpl'
import { MAX_MPT_AMOUNT, fromBaseUnits, toBaseUnits } from './amount.js'
import type { BanRecord, BanRegistry } from './banRegistry.js'
import { ComplianceViolationError, LedgerStateError, ValidationError } from './errors.js'
import type { TransactionSubmitter, ValidatedTransaction } from './submit.js'

type MPTokenIssuance = LedgerEntry.MPTokenIssuance
type MPToken = LedgerEntry.MPToken

/** MPTokenIssuance ledger flags (xrpl.org: MPTokenIssuance > Flags). */
const lsfMPTLocked = 0x01
const lsfMPTCanLock = 0x02
const lsfMPTRequireAuth = 0x04
const lsfMPTCanEscrow = 0x08
const lsfMPTCanTrade = 0x10
const lsfMPTCanTransfer = 0x20
const lsfMPTCanClawback = 0x40
/** MPToken ledger flags (xrpl.org: MPToken > Flags). */
const lsfMPTokenLocked = 0x01
const lsfMPTokenAuthorized = 0x02

/** Flags every issuance managed by this module must have. */
const REQUIRED_ISSUANCE_FLAGS = lsfMPTCanLock | lsfMPTRequireAuth | lsfMPTCanClawback

export interface IssuanceConfig {
  /** Decimal places of the token, e.g. 2 means 1 token = 100 base units. Cannot be changed later. */
  assetScale: number
  /** XLS-89 metadata. Validated strictly, and cannot be changed later without the DynamicMPT amendment. */
  metadata: MPTokenMetadata
  /** Optional supply cap, in token units (e.g. "1000000.00"). */
  maximumAmount?: string
  /**
   * Allow holder-to-holder transfers (tfMPTCanTransfer). Default true. If
   * false, holders can only send the token back to the issuer.
   */
  allowHolderTransfers?: boolean
}

export interface IssuanceState {
  issuanceId: string
  issuer: string
  assetScale: number
  outstanding: string
  maximumAmount: string | undefined
  globallyFrozen: boolean
  capabilities: {
    requireAuth: boolean
    canLock: boolean
    canClawback: boolean
    canTransfer: boolean
    canEscrow: boolean
    canTrade: boolean
  }
}

export interface HolderState {
  address: string
  /** Whether the holder has opted in (an MPToken entry exists). */
  optedIn: boolean
  /** On the issuer's allowlist (lsfMPTAuthorized). */
  approved: boolean
  /** Individually frozen (lsfMPTLocked on the holder's MPToken). */
  frozen: boolean
  /** Recorded as banned in the ban registry. */
  banned: boolean
  balance: string
  balanceBaseUnits: bigint
}

export type AuditAction =
  | 'create_issuance'
  | 'approve'
  | 'revoke_approval'
  | 'issue'
  | 'clawback'
  | 'freeze_holder'
  | 'unfreeze_holder'
  | 'freeze_all'
  | 'unfreeze_all'
  | 'ban'

export interface AuditEvent {
  at: string
  issuanceId: string
  action: AuditAction
  holder?: string
  amount?: string
  txHash?: string
  reason?: string
  detail?: string
}

export interface MptIssuerDeps {
  client: Client
  submitter: TransactionSubmitter
  banRegistry: BanRegistry
  /** Receives one event per compliance action applied on ledger. Wire this to your audit log. */
  onAudit?: (event: AuditEvent) => void
}

export interface ActionResult {
  /** False if the ledger was already in the requested state and nothing was submitted. */
  changed: boolean
  txHash?: string
}

export interface ClawbackResult extends ActionResult {
  clawedBack: string
}

export interface BanResult {
  address: string
  txHashes: string[]
  clawedBack: string
  record: BanRecord
}

/**
 * Issuer-side compliance controls for one MPT issuance: allowlist, issuance,
 * clawback, bans, per-holder freeze and global freeze.
 *
 * Every mutating call checks the validated ledger state first and runs
 * exclusively (one at a time per instance), so a check can't be invalidated by
 * a concurrent call from the same process. Run a single instance per issuance;
 * across processes, use an external lock.
 */
export class MptIssuer {
  private exclusiveChain: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly deps: MptIssuerDeps,
    private readonly wallet: Wallet,
    readonly issuanceId: string,
    readonly assetScale: number,
  ) {}

  /**
   * Creates a new issuance with allowlisting, locking and clawback enabled.
   * Escrow and DEX trading are deliberately not enabled: clawback can't reach
   * escrowed balances, and neither feature is needed for the controls here.
   */
  static async create(deps: MptIssuerDeps, wallet: Wallet, config: IssuanceConfig): Promise<MptIssuer> {
    const metadataHex = encodeMPTokenMetadata(config.metadata)
    const problems = validateMPTokenMetadata(metadataHex)
    if (problems.length > 0) {
      throw new ValidationError(`MPTokenMetadata is not XLS-89 compliant: ${problems.join('; ')}`)
    }
    if (!Number.isInteger(config.assetScale) || config.assetScale < 0 || config.assetScale > 19) {
      throw new ValidationError('assetScale must be an integer between 0 and 19')
    }

    let flags =
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback
    if (config.allowHolderTransfers ?? true) flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer

    const outcome = await deps.submitter.submit(wallet, {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      AssetScale: config.assetScale,
      Flags: flags,
      MPTokenMetadata: metadataHex,
      ...(config.maximumAmount !== undefined && {
        MaximumAmount: toBaseUnits(config.maximumAmount, config.assetScale).toString(),
      }),
    })
    const issuanceId = (outcome.meta as TransactionMetadata & { mpt_issuance_id?: string }).mpt_issuance_id
    if (!issuanceId) throw new LedgerStateError(`MPTokenIssuanceCreate ${outcome.hash} returned no mpt_issuance_id`)

    const issuer = new MptIssuer(deps, wallet, issuanceId, config.assetScale)
    issuer.audit({ action: 'create_issuance', txHash: outcome.hash, detail: `flags=${flags}` })
    return issuer
  }

  /** Attaches to an existing issuance after checking that `wallet` issued it and that all controls are enabled. */
  static async load(deps: MptIssuerDeps, wallet: Wallet, issuanceId: string): Promise<MptIssuer> {
    const issuance = await readIssuance(deps.client, issuanceId)
    if (issuance.Issuer !== wallet.classicAddress) {
      throw new LedgerStateError(`Issuance ${issuanceId} is issued by ${issuance.Issuer}, not ${wallet.classicAddress}`)
    }
    if ((issuance.Flags & REQUIRED_ISSUANCE_FLAGS) !== REQUIRED_ISSUANCE_FLAGS) {
      throw new LedgerStateError(`Issuance ${issuanceId} lacks RequireAuth, CanLock or CanClawback`)
    }
    return new MptIssuer(deps, wallet, issuanceId, issuance.AssetScale ?? 0)
  }

  get issuerAddress(): string {
    return this.wallet.classicAddress
  }

  async getIssuanceState(): Promise<IssuanceState> {
    const issuance = await readIssuance(this.deps.client, this.issuanceId)
    const has = (flag: number): boolean => (issuance.Flags & flag) !== 0
    return {
      issuanceId: this.issuanceId,
      issuer: issuance.Issuer,
      assetScale: this.assetScale,
      outstanding: fromBaseUnits(BigInt(issuance.OutstandingAmount ?? '0'), this.assetScale),
      maximumAmount:
        issuance.MaximumAmount === undefined
          ? undefined
          : fromBaseUnits(BigInt(issuance.MaximumAmount), this.assetScale),
      globallyFrozen: has(lsfMPTLocked),
      capabilities: {
        requireAuth: has(lsfMPTRequireAuth),
        canLock: has(lsfMPTCanLock),
        canClawback: has(lsfMPTCanClawback),
        canTransfer: has(lsfMPTCanTransfer),
        canEscrow: has(lsfMPTCanEscrow),
        canTrade: has(lsfMPTCanTrade),
      },
    }
  }

  async getHolderState(address: string): Promise<HolderState> {
    this.assertHolderAddress(address)
    const [token, banned] = await Promise.all([
      readMPToken(this.deps.client, this.issuanceId, address),
      this.deps.banRegistry.isBanned(this.issuanceId, address),
    ])
    const balanceBaseUnits = BigInt(token?.MPTAmount ?? '0')
    return {
      address,
      optedIn: token !== undefined,
      approved: token !== undefined && (token.Flags & lsfMPTokenAuthorized) !== 0,
      frozen: token !== undefined && (token.Flags & lsfMPTokenLocked) !== 0,
      banned,
      balance: fromBaseUnits(balanceBaseUnits, this.assetScale),
      balanceBaseUnits,
    }
  }

  /** Adds a KYC-approved holder to the allowlist. The holder must have opted in first. */
  async approveHolder(address: string, reason?: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      const holder = await this.getHolderState(address)
      if (holder.banned) throw new ComplianceViolationError(`${address} is banned and cannot be approved`)
      if (!holder.optedIn) {
        throw new LedgerStateError(`${address} has not opted in to ${this.issuanceId} (no MPToken entry)`)
      }
      if (holder.approved) return { changed: false }
      const tx = await this.submit({
        TransactionType: 'MPTokenAuthorize',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Holder: address,
      })
      this.audit({ action: 'approve', holder: address, txHash: tx.hash, reason })
      return { changed: true, txHash: tx.hash }
    })
  }

  /**
   * Removes a holder from the allowlist. They keep any balance but can neither
   * send nor receive the token until re-approved. Use `ban` to also remove the balance.
   */
  async revokeApproval(address: string, reason?: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      const holder = await this.getHolderState(address)
      if (!holder.approved) return { changed: false }
      const hash = await this.unauthorize(address)
      this.audit({ action: 'revoke_approval', holder: address, txHash: hash, reason })
      return { changed: true, txHash: hash }
    })
  }

  /**
   * Issues (mints) `amount` tokens to an approved holder. Refuses to issue to
   * holders that are banned, not approved or frozen, and while the token is
   * globally frozen. The ledger itself lets an issuer pay a frozen holder, so
   * this check is what keeps frozen holders from receiving.
   */
  async issue(address: string, amount: string, reason?: string): Promise<ActionResult> {
    const units = toBaseUnits(amount, this.assetScale)
    return this.exclusive(async () => {
      const [holder, issuance] = await Promise.all([this.getHolderState(address), this.getIssuanceState()])
      if (holder.banned) throw new ComplianceViolationError(`${address} is banned`)
      if (!holder.approved) throw new ComplianceViolationError(`${address} is not an approved holder`)
      if (holder.frozen) throw new ComplianceViolationError(`${address} is frozen`)
      if (issuance.globallyFrozen) throw new ComplianceViolationError('The token is globally frozen')

      const tx = await this.submit({
        TransactionType: 'Payment',
        Account: this.issuerAddress,
        Destination: address,
        Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
      })
      this.audit({ action: 'issue', holder: address, amount: fromBaseUnits(units, this.assetScale), txHash: tx.hash, reason })
      return { changed: true, txHash: tx.hash }
    })
  }

  /**
   * Claws back `amount` tokens (or the whole balance with "all") from any
   * holder, whether or not they are frozen or approved. If `amount` is more
   * than the balance, the whole balance is clawed back. The result reports the
   * amount actually removed, read from the transaction metadata.
   */
  async clawback(address: string, amount: string | 'all', reason?: string): Promise<ClawbackResult> {
    const requested = amount === 'all' ? MAX_MPT_AMOUNT : toBaseUnits(amount, this.assetScale)
    return this.exclusive(async () => {
      const holder = await this.getHolderState(address)
      if (holder.balanceBaseUnits === 0n) {
        if (amount === 'all') return { changed: false, clawedBack: '0' }
        throw new LedgerStateError(`${address} holds none of the token`)
      }
      const { hash, clawedBack } = await this.clawbackUnits(address, requested)
      this.audit({ action: 'clawback', holder: address, amount: clawedBack, txHash: hash, reason })
      return { changed: true, txHash: hash, clawedBack }
    })
  }

  /** Freezes one holder: they can no longer send to or receive from other holders. */
  async freezeHolder(address: string, reason?: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      const holder = await this.requireOptedIn(address)
      if (holder.frozen) return { changed: false }
      const hash = await this.setHolderLock(address, true)
      this.audit({ action: 'freeze_holder', holder: address, txHash: hash, reason })
      return { changed: true, txHash: hash }
    })
  }

  async unfreezeHolder(address: string, reason?: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      const holder = await this.requireOptedIn(address)
      if (holder.banned) throw new ComplianceViolationError(`${address} is banned and stays frozen`)
      if (!holder.frozen) return { changed: false }
      const hash = await this.setHolderLock(address, false)
      this.audit({ action: 'unfreeze_holder', holder: address, txHash: hash, reason })
      return { changed: true, txHash: hash }
    })
  }

  /** Freezes all transfers between holders. Issuance also stops (enforced by this module). */
  async freezeAll(reason?: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      if ((await this.getIssuanceState()).globallyFrozen) return { changed: false }
      const tx = await this.submit({
        TransactionType: 'MPTokenIssuanceSet',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Flags: MPTokenIssuanceSetFlags.tfMPTLock,
      })
      this.audit({ action: 'freeze_all', txHash: tx.hash, reason })
      return { changed: true, txHash: tx.hash }
    })
  }

  async unfreezeAll(reason?: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      if (!(await this.getIssuanceState()).globallyFrozen) return { changed: false }
      const tx = await this.submit({
        TransactionType: 'MPTokenIssuanceSet',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Flags: MPTokenIssuanceSetFlags.tfMPTUnlock,
      })
      this.audit({ action: 'unfreeze_all', txHash: tx.hash, reason })
      return { changed: true, txHash: tx.hash }
    })
  }

  /**
   * Bans an address permanently. The steps:
   *   1. Record the ban durably, so the address can never be re-approved.
   *   2. Freeze the holder, so nothing moves while the ban is carried out.
   *   3. Remove them from the allowlist. The ledger then rejects any payment to them.
   *   4. Claw back their entire balance.
   *   5. Re-read the validated ledger to confirm: zero balance, not approved.
   * Safe to call again; completed steps are skipped, so a ban interrupted
   * partway through can be finished by calling this again.
   */
  async ban(address: string, reason: string): Promise<BanResult> {
    if (!reason.trim()) throw new ValidationError('A ban requires a reason')
    this.assertHolderAddress(address)
    return this.exclusive(async () => {
      const record: BanRecord = (await this.deps.banRegistry.get(this.issuanceId, address)) ?? {
        issuanceId: this.issuanceId,
        address,
        reason,
        bannedAt: new Date().toISOString(),
      }
      await this.deps.banRegistry.record(record)

      const txHashes: string[] = []
      let clawedBack = '0'
      const holder = await this.getHolderState(address)
      if (holder.optedIn) {
        if (!holder.frozen) txHashes.push(await this.setHolderLock(address, true))
        if (holder.approved) txHashes.push(await this.unauthorize(address))
        if (holder.balanceBaseUnits > 0n) {
          const result = await this.clawbackUnits(address, MAX_MPT_AMOUNT)
          txHashes.push(result.hash)
          clawedBack = result.clawedBack
        }
      }

      const after = await this.getHolderState(address)
      if (after.balanceBaseUnits !== 0n || after.approved) {
        throw new LedgerStateError(
          `Ban of ${address} did not complete: balance=${after.balance}, approved=${after.approved}`,
        )
      }
      this.audit({ action: 'ban', holder: address, amount: clawedBack, txHash: txHashes.at(-1), reason, detail: txHashes.join(',') })
      return { address, txHashes, clawedBack, record }
    })
  }

  // --- internals -----------------------------------------------------------

  private async requireOptedIn(address: string): Promise<HolderState> {
    const holder = await this.getHolderState(address)
    if (!holder.optedIn) throw new LedgerStateError(`${address} holds no MPToken entry for ${this.issuanceId}`)
    return holder
  }

  private async setHolderLock(address: string, lock: boolean): Promise<string> {
    const tx = await this.submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    return tx.hash
  }

  private async unauthorize(address: string): Promise<string> {
    const tx = await this.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
    return tx.hash
  }

  private async clawbackUnits(address: string, units: bigint): Promise<{ hash: string; clawedBack: string }> {
    const tx = await this.submit({
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Holder: address,
      Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
    })
    return { hash: tx.hash, clawedBack: fromBaseUnits(mptBalanceDecrease(tx.meta, address), this.assetScale) }
  }

  private async submit(tx: Parameters<TransactionSubmitter['submit']>[1]): Promise<ValidatedTransaction> {
    return this.deps.submitter.submit(this.wallet, tx)
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.exclusiveChain.catch(() => undefined).then(task)
    this.exclusiveChain = run
    return run
  }

  private assertHolderAddress(address: string): void {
    if (!isValidClassicAddress(address)) throw new ValidationError(`Invalid classic address: ${address}`)
    if (address === this.issuerAddress) throw new ValidationError('The issuer cannot be a holder of its own token')
  }

  private audit(event: Omit<AuditEvent, 'at' | 'issuanceId'>): void {
    this.deps.onAudit?.({ at: new Date().toISOString(), issuanceId: this.issuanceId, ...event })
  }
}

async function readIssuance(client: Client, issuanceId: string): Promise<MPTokenIssuance> {
  const entry = await readLedgerEntry(client, { mpt_issuance: issuanceId })
  if (!entry) throw new LedgerStateError(`MPT issuance ${issuanceId} not found in the validated ledger`)
  return entry as MPTokenIssuance
}

async function readMPToken(client: Client, issuanceId: string, account: string): Promise<MPToken | undefined> {
  const entry = await readLedgerEntry(client, { mptoken: { mpt_issuance_id: issuanceId, account } })
  return entry as MPToken | undefined
}

async function readLedgerEntry(
  client: Client,
  selector: { mpt_issuance: string } | { mptoken: { mpt_issuance_id: string; account: string } },
): Promise<unknown> {
  try {
    const response = await client.request({ command: 'ledger_entry', ledger_index: 'validated', ...selector })
    return response.result.node
  } catch (error) {
    if ((error as { data?: { error?: string } }).data?.error === 'entryNotFound') return undefined
    throw error
  }
}

/** Reads how far `holder`'s MPToken balance went down in a transaction, from its metadata. */
function mptBalanceDecrease(meta: TransactionMetadata, holder: string): bigint {
  for (const node of meta.AffectedNodes) {
    const modified = 'ModifiedNode' in node ? node.ModifiedNode : undefined
    if (modified?.LedgerEntryType !== 'MPToken' || modified.FinalFields?.['Account'] !== holder) continue
    // MPTAmount is omitted from the ledger entry when it is zero, and from
    // PreviousFields when it did not change.
    const finalAmount = (modified.FinalFields['MPTAmount'] as string | undefined) ?? '0'
    const before = BigInt((modified.PreviousFields?.['MPTAmount'] as string | undefined) ?? finalAmount)
    const after = BigInt(finalAmount)
    return before - after
  }
  throw new LedgerStateError(`Transaction metadata has no MPToken change for ${holder}`)
}
