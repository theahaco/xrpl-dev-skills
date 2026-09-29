import {
  type Client,
  type LedgerEntry,
  type MPTokenMetadata,
  type Node,
  type SubmittableTransaction,
  type TransactionMetadata,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  validateMPTokenMetadata,
} from 'xrpl'
import { MAX_MPT_AMOUNT, fromBaseUnits, toBaseUnits, toPositiveBaseUnits } from './amount.js'
import type { BanRecord, BanRegistry } from './ban-registry.js'
import {
  ComplianceViolationError,
  IncompleteActionError,
  InvalidInputError,
  IssuerError,
  NetworkMismatchError,
} from './errors.js'
import { type Receipt, type Signer, Submitter, type SubmitterOptions } from './submitter.js'

// MPTokenIssuance ledger-entry flags.
const lsfMPTLocked = 0x01
const lsfMPTCanLock = 0x02
const lsfMPTRequireAuth = 0x04
const lsfMPTCanEscrow = 0x08
const lsfMPTCanTrade = 0x10
const lsfMPTCanTransfer = 0x20
const lsfMPTCanClawback = 0x40
const lsfMPTCanHoldConfidentialBalance = 0x80
// MPToken (holder) ledger-entry flags.
const lsfMPTokenLocked = 0x01
const lsfMPTokenAuthorized = 0x02

/** Capabilities every issuance managed by this module must have. */
const REQUIRED_FLAGS = lsfMPTCanLock | lsfMPTRequireAuth | lsfMPTCanClawback
/**
 * Capabilities that would let tokens move where clawback or a ban can't reach:
 * escrowed amounts, DEX/AMM holdings, and confidential balances.
 */
const FORBIDDEN_FLAGS = lsfMPTCanEscrow | lsfMPTCanTrade | lsfMPTCanHoldConfidentialBalance

export interface TokenDefinition {
  /** Number of decimal places. 2 means an amount of "1.23" is stored as 123 base units. 0-19. */
  assetScale: number
  /** Optional hard cap on outstanding supply, as a decimal string. */
  maximumAmount?: string
  /** XLS-89 metadata. It is validated strictly: any warning from xrpl.js is treated as an error. */
  metadata: MPTokenMetadata
  /**
   * Whether approved holders may transfer to each other. Default true.
   * If false, tokens can only move between the issuer and holders.
   */
  transferable?: boolean
}

export interface IssuanceState {
  issuanceId: string
  issuer: string
  assetScale: number
  outstandingAmount: string
  maximumAmount: string | undefined
  globallyFrozen: boolean
  capabilities: {
    canLock: boolean
    requireAuth: boolean
    canClawback: boolean
    canTransfer: boolean
    canEscrow: boolean
    canTrade: boolean
  }
}

export interface HolderState {
  address: string
  /** The holder has created its MPToken entry (opted in). This is required before approval. */
  optedIn: boolean
  /** Approved by the issuer (on the allowlist). */
  authorized: boolean
  /** Individually frozen (locked). */
  frozen: boolean
  balance: string
  ban: BanRecord | undefined
}

export interface ActionContext {
  /** Who initiated the action (operator id, service name). Recorded in the audit trail. */
  actor?: string
  /** External reference, e.g. a KYC case id, redemption ticket or incident number. */
  reference?: string
}

export interface AuditEvent {
  action:
    | 'create_issuance'
    | 'approve_holder'
    | 'revoke_holder'
    | 'issue'
    | 'clawback'
    | 'freeze_holder'
    | 'unfreeze_holder'
    | 'freeze_all'
    | 'unfreeze_all'
    | 'ban'
  outcome: 'succeeded' | 'refused' | 'failed' | 'no_op'
  issuanceId: string | undefined
  holder?: string
  amount?: string
  reason?: string
  actor?: string
  reference?: string
  txHash?: string
  error?: string
  timestamp: string
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>

export interface IssuerOptions extends SubmitterOptions {
  client: Client
  signer: Signer
  banRegistry: BanRegistry
  /**
   * If set, refuses to operate unless the connected server reports this
   * network id (0 = mainnet, 1 = testnet, 2 = devnet).
   */
  expectedNetworkId?: number
  /**
   * Called after every action, including refusals and failures. Errors thrown
   * by the sink are logged and swallowed, because the ledger action has
   * already happened by then.
   */
  audit?: AuditSink
}

export interface ClawbackResult extends Receipt {
  /** Amount actually removed from the holder, as reported by the ledger. */
  clawedBack: string
}

export interface BanResult {
  ban: BanRecord
  /** Amount clawed back as part of the ban ("0" if the holder held nothing). */
  clawedBack: string
  transactions: string[]
}

/**
 * Issuer-side controls for a regulated MPT.
 *
 * On-ledger guarantees (enforced by the XRP Ledger itself):
 *  - Only approved holders can receive or send the token (tfMPTRequireAuth).
 *  - Frozen holders, and everyone during a global freeze, cannot transfer to or
 *    from other holders.
 *  - The issuer can claw back any amount from any holder at any time.
 *
 * Guarantees enforced by this module (the ledger does not enforce them):
 *  - The issuer never sends tokens to a banned, unapproved or frozen holder,
 *    or to anyone while the token is globally frozen. The ledger itself would
 *    allow issuer -> frozen-holder payments.
 *  - Banned addresses can never be approved again (see {@link BanRegistry}).
 *
 * Protocol limitation: a frozen holder can still send tokens back to the
 * issuer, which redeems them and reduces supply. MPT locking only blocks
 * transfers between holders.
 */
export class MptIssuer {
  private readonly submitter: Submitter

  private constructor(
    private readonly options: IssuerOptions,
    readonly issuanceId: string,
    readonly assetScale: number,
  ) {
    this.submitter = new Submitter(options.client, options.signer, options)
  }

  get issuerAddress(): string {
    return this.options.signer.classicAddress
  }

  /** Creates a new issuance with all compliance capabilities enabled. */
  static async create(
    options: IssuerOptions,
    token: TokenDefinition,
    context: ActionContext = {},
  ): Promise<MptIssuer> {
    await assertNetwork(options)
    const { assetScale } = token
    if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 19) {
      throw new InvalidInputError('assetScale must be an integer between 0 and 19')
    }
    const maximum = token.maximumAmount === undefined ? undefined : toPositiveBaseUnits(token.maximumAmount, assetScale)
    const metadataHex = encodeMPTokenMetadata(token.metadata)
    const warnings = validateMPTokenMetadata(metadataHex)
    if (warnings.length > 0) {
      throw new InvalidInputError(`Token metadata is not XLS-89 compliant:\n- ${warnings.join('\n- ')}`)
    }

    let flags =
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback
    if (token.transferable ?? true) flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer

    const tx: SubmittableTransaction = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: options.signer.classicAddress,
      AssetScale: assetScale,
      Flags: flags,
      MPTokenMetadata: metadataHex,
      ...(maximum === undefined ? {} : { MaximumAmount: maximum.toString() }),
    }
    const submitter = new Submitter(options.client, options.signer, options)
    const receipt = await submitter.exclusive(() => submitter.submitUnlocked(tx))
    const issuanceId = (receipt.meta as TransactionMetadata & { mpt_issuance_id?: string }).mpt_issuance_id
    if (!issuanceId) {
      throw new IssuerError(`MPTokenIssuanceCreate ${receipt.hash} succeeded but returned no mpt_issuance_id`)
    }
    const issuer = new MptIssuer(options, issuanceId, assetScale)
    await issuer.emit({ action: 'create_issuance', outcome: 'succeeded', txHash: receipt.hash, ...context })
    return issuer
  }

  /**
   * Attaches to an existing issuance. Refuses if it was issued by a different
   * account, lacks a required control, or enables a capability that would let
   * tokens escape clawback.
   */
  static async load(options: IssuerOptions, issuanceId: string): Promise<MptIssuer> {
    await assertNetwork(options)
    const entry = await fetchIssuance(options.client, issuanceId)
    if (!entry) throw new InvalidInputError(`MPT issuance ${issuanceId} does not exist`)
    if (entry.Issuer !== options.signer.classicAddress) {
      throw new InvalidInputError(`Issuance ${issuanceId} belongs to ${entry.Issuer}, not ${options.signer.classicAddress}`)
    }
    if ((entry.Flags & REQUIRED_FLAGS) !== REQUIRED_FLAGS) {
      throw new InvalidInputError(`Issuance ${issuanceId} lacks a required control (lock, require-auth or clawback)`)
    }
    if ((entry.Flags & FORBIDDEN_FLAGS) !== 0) {
      throw new InvalidInputError(`Issuance ${issuanceId} allows escrow, trading or confidential balances`)
    }
    if (entry.DomainID !== undefined) {
      throw new InvalidInputError(`Issuance ${issuanceId} delegates authorization to a permissioned domain`)
    }
    return new MptIssuer(options, issuanceId, entry.AssetScale ?? 0)
  }

  // ---------------------------------------------------------------- reads

  async getIssuance(): Promise<IssuanceState> {
    const entry = await fetchIssuance(this.options.client, this.issuanceId)
    if (!entry) throw new IssuerError(`MPT issuance ${this.issuanceId} no longer exists`)
    const has = (flag: number) => (entry.Flags & flag) !== 0
    return {
      issuanceId: this.issuanceId,
      issuer: entry.Issuer,
      assetScale: this.assetScale,
      outstandingAmount: fromBaseUnits(BigInt(entry.OutstandingAmount), this.assetScale),
      maximumAmount:
        entry.MaximumAmount === undefined ? undefined : fromBaseUnits(BigInt(entry.MaximumAmount), this.assetScale),
      globallyFrozen: has(lsfMPTLocked),
      capabilities: {
        canLock: has(lsfMPTCanLock),
        requireAuth: has(lsfMPTRequireAuth),
        canClawback: has(lsfMPTCanClawback),
        canTransfer: has(lsfMPTCanTransfer),
        canEscrow: has(lsfMPTCanEscrow),
        canTrade: has(lsfMPTCanTrade),
      },
    }
  }

  /** Current validated state of a holder. */
  async getHolder(address: string): Promise<HolderState> {
    this.assertHolderAddress(address)
    const [entry, ban] = await Promise.all([this.fetchHolder(address), this.options.banRegistry.get(address)])
    return {
      address,
      optedIn: entry !== undefined,
      authorized: entry !== undefined && (entry.Flags & lsfMPTokenAuthorized) !== 0,
      frozen: entry !== undefined && (entry.Flags & lsfMPTokenLocked) !== 0,
      balance: fromBaseUnits(BigInt(entry?.MPTAmount ?? '0'), this.assetScale),
      ban,
    }
  }

  async isBanned(address: string): Promise<boolean> {
    return (await this.options.banRegistry.get(address)) !== undefined
  }

  // ------------------------------------------------------------ allowlist

  /**
   * Adds a holder to the allowlist. Call this only after KYC has passed. The
   * holder must first opt in by submitting its own MPTokenAuthorize.
   */
  approveHolder(address: string, context: ActionContext = {}): Promise<Receipt | undefined> {
    return this.action('approve_holder', { holder: address, ...context }, async () => {
      await this.assertNotBanned(address)
      const holder = await this.requireOptedIn(address)
      if ((holder.Flags & lsfMPTokenAuthorized) !== 0) return undefined
      return this.submitUnlocked({
        TransactionType: 'MPTokenAuthorize',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Holder: address,
      })
    })
  }

  /**
   * Removes a holder from the allowlist (e.g. KYC expired) without banning
   * them. Any remaining balance is immobilized until the holder is approved
   * again or the balance is clawed back.
   */
  revokeHolder(address: string, reason: string, context: ActionContext = {}): Promise<Receipt | undefined> {
    return this.action('revoke_holder', { holder: address, reason, ...context }, async () => {
      const holder = await this.requireOptedIn(address)
      if ((holder.Flags & lsfMPTokenAuthorized) === 0) return undefined
      return this.submitUnlocked(this.unauthorizeTx(address))
    })
  }

  // --------------------------------------------------------------- supply

  /** Sends newly issued tokens from the issuer to an approved, unfrozen holder. */
  issue(address: string, amount: string, context: ActionContext = {}): Promise<Receipt> {
    return this.action('issue', { holder: address, amount, ...context }, async () => {
      const units = toPositiveBaseUnits(amount, this.assetScale)
      await this.assertNotBanned(address)
      const [holder, issuance] = await Promise.all([this.requireOptedIn(address), this.requireIssuance()])
      if ((holder.Flags & lsfMPTokenAuthorized) === 0) {
        throw new ComplianceViolationError('HOLDER_NOT_AUTHORIZED', `${address} is not an approved holder`)
      }
      if ((holder.Flags & lsfMPTokenLocked) !== 0) {
        throw new ComplianceViolationError('HOLDER_FROZEN', `${address} is frozen`)
      }
      if ((issuance.Flags & lsfMPTLocked) !== 0) {
        throw new ComplianceViolationError('GLOBALLY_FROZEN', 'The token is globally frozen')
      }
      const maximum = issuance.MaximumAmount === undefined ? MAX_MPT_AMOUNT : BigInt(issuance.MaximumAmount)
      if (BigInt(issuance.OutstandingAmount) + units > maximum) {
        throw new ComplianceViolationError('MAXIMUM_AMOUNT_EXCEEDED', `Issuing ${amount} would exceed the maximum supply`)
      }
      return this.submitUnlocked({
        TransactionType: 'Payment',
        Account: this.issuerAddress,
        Destination: address,
        Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
      })
    })
  }

  /**
   * Claws back `amount` from a holder. This works whether or not the holder is
   * frozen, unapproved or banned, and during a global freeze. The amount must
   * not exceed the holder's current balance.
   */
  clawback(address: string, amount: string, reason: string, context: ActionContext = {}): Promise<ClawbackResult> {
    return this.action('clawback', { holder: address, amount, reason, ...context }, async () => {
      const units = toPositiveBaseUnits(amount, this.assetScale)
      const holder = await this.requireOptedIn(address)
      const balance = BigInt(holder.MPTAmount ?? '0')
      if (units > balance) {
        throw new ComplianceViolationError(
          'INSUFFICIENT_BALANCE',
          `${address} holds ${fromBaseUnits(balance, this.assetScale)}, less than the ${amount} requested`,
        )
      }
      return this.clawbackUnlocked(address, units)
    })
  }

  // --------------------------------------------------------------- freeze

  /** Stops a holder from sending or receiving the token. Idempotent. */
  freezeHolder(address: string, reason: string, context: ActionContext = {}): Promise<Receipt | undefined> {
    return this.action('freeze_holder', { holder: address, reason, ...context }, async () => {
      const holder = await this.requireOptedIn(address)
      if ((holder.Flags & lsfMPTokenLocked) !== 0) return undefined
      return this.submitUnlocked(this.lockTx(MPTokenIssuanceSetFlags.tfMPTLock, address))
    })
  }

  /** Lifts an individual freeze. Refuses for banned holders. Idempotent. */
  unfreezeHolder(address: string, reason: string, context: ActionContext = {}): Promise<Receipt | undefined> {
    return this.action('unfreeze_holder', { holder: address, reason, ...context }, async () => {
      await this.assertNotBanned(address)
      const holder = await this.requireOptedIn(address)
      if ((holder.Flags & lsfMPTokenLocked) === 0) return undefined
      return this.submitUnlocked(this.lockTx(MPTokenIssuanceSetFlags.tfMPTUnlock, address))
    })
  }

  /** Freezes all movement of the token between holders. Idempotent. */
  freezeAll(reason: string, context: ActionContext = {}): Promise<Receipt | undefined> {
    return this.action('freeze_all', { reason, ...context }, async () => {
      const issuance = await this.requireIssuance()
      if ((issuance.Flags & lsfMPTLocked) !== 0) return undefined
      return this.submitUnlocked(this.lockTx(MPTokenIssuanceSetFlags.tfMPTLock))
    })
  }

  /** Lifts a global freeze. Individual freezes stay in place. Idempotent. */
  unfreezeAll(reason: string, context: ActionContext = {}): Promise<Receipt | undefined> {
    return this.action('unfreeze_all', { reason, ...context }, async () => {
      const issuance = await this.requireIssuance()
      if ((issuance.Flags & lsfMPTLocked) === 0) return undefined
      return this.submitUnlocked(this.lockTx(MPTokenIssuanceSetFlags.tfMPTUnlock))
    })
  }

  // ------------------------------------------------------------------ ban

  /**
   * Permanently bans an address:
   *  1. records the ban in the registry, so a crash part-way can't lose it;
   *  2. revokes approval, which on-ledger blocks every inbound and outbound transfer;
   *  3. claws back the entire balance, which can no longer change;
   *  4. freezes the holder as a second line of defence;
   *  5. verifies on the validated ledger that the balance is zero and approval is gone.
   *
   * Idempotent: calling it again completes any step that did not finish.
   * Addresses that never opted in are only recorded, since they can't hold
   * the token and can never be approved.
   */
  ban(address: string, reason: string, context: ActionContext = {}): Promise<BanResult> {
    return this.action('ban', { holder: address, reason, ...context }, async () => {
      this.assertHolderAddress(address)
      requireReason(reason)
      const ban = await this.options.banRegistry.add({ address, reason, bannedAt: new Date().toISOString() })
      const transactions: string[] = []
      let clawedBack = 0n
      try {
        let holder = await this.fetchHolder(address)
        if (holder && (holder.Flags & lsfMPTokenAuthorized) !== 0) {
          transactions.push((await this.submitUnlocked(this.unauthorizeTx(address))).hash)
        }
        holder = await this.fetchHolder(address)
        const balance = BigInt(holder?.MPTAmount ?? '0')
        if (balance > 0n) {
          const result = await this.clawbackUnlocked(address, balance)
          transactions.push(result.hash)
          clawedBack = balance
        }
        if (holder && (holder.Flags & lsfMPTokenLocked) === 0) {
          transactions.push((await this.submitUnlocked(this.lockTx(MPTokenIssuanceSetFlags.tfMPTLock, address))).hash)
        }
        const final = await this.fetchHolder(address)
        if (final && (BigInt(final.MPTAmount ?? '0') !== 0n || (final.Flags & lsfMPTokenAuthorized) !== 0)) {
          throw new IssuerError(`post-ban verification failed: ${JSON.stringify(final)}`)
        }
      } catch (error) {
        throw new IncompleteActionError(
          `Ban of ${address} is recorded but not fully enforced on-ledger (${String(error)}). Re-run ban() to complete it.`,
          { cause: error },
        )
      }
      return { ban, clawedBack: fromBaseUnits(clawedBack, this.assetScale), transactions }
    })
  }

  // ------------------------------------------------------------ internals

  /**
   * Runs one compliance action: validates input, serializes it against all
   * other actions on this issuer (so check-then-submit can't race), and
   * writes an audit event whatever the outcome.
   */
  private async action<T extends Receipt | BanResult | undefined>(
    action: AuditEvent['action'],
    details: Omit<AuditEvent, 'action' | 'outcome' | 'issuanceId' | 'timestamp'>,
    body: () => Promise<T>,
  ): Promise<T> {
    if (details.holder !== undefined) this.assertHolderAddress(details.holder)
    if ('reason' in details) requireReason(details.reason)
    try {
      const result = await this.submitter.exclusive(body)
      const txHash = result && 'hash' in result ? result.hash : undefined
      await this.emit({
        action,
        ...details,
        outcome: result === undefined ? 'no_op' : 'succeeded',
        ...(txHash === undefined ? {} : { txHash }),
      })
      return result
    } catch (error) {
      await this.emit({
        action,
        ...details,
        outcome: error instanceof ComplianceViolationError || error instanceof InvalidInputError ? 'refused' : 'failed',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
      throw error
    }
  }

  private async clawbackUnlocked(address: string, units: bigint): Promise<ClawbackResult> {
    const receipt = await this.submitUnlocked({
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Holder: address,
      Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
    })
    return { ...receipt, clawedBack: fromBaseUnits(this.outstandingDecrease(receipt.meta), this.assetScale) }
  }

  /** Reads the actual clawed-back amount from the issuance's OutstandingAmount change. */
  private outstandingDecrease(meta: TransactionMetadata): bigint {
    for (const node of meta.AffectedNodes as Node[]) {
      if (!('ModifiedNode' in node) || node.ModifiedNode.LedgerEntryType !== 'MPTokenIssuance') continue
      const previous = node.ModifiedNode.PreviousFields?.OutstandingAmount
      const final = node.ModifiedNode.FinalFields?.OutstandingAmount
      if (typeof previous === 'string' && typeof final === 'string') return BigInt(previous) - BigInt(final)
    }
    return 0n
  }

  private submitUnlocked(tx: SubmittableTransaction): Promise<Receipt> {
    return this.submitter.submitUnlocked(tx)
  }

  private unauthorizeTx(address: string): SubmittableTransaction {
    return {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    }
  }

  private lockTx(flag: MPTokenIssuanceSetFlags, holder?: string): SubmittableTransaction {
    return {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Flags: flag,
      ...(holder === undefined ? {} : { Holder: holder }),
    }
  }

  private async requireIssuance(): Promise<IssuanceEntry> {
    const entry = await fetchIssuance(this.options.client, this.issuanceId)
    if (!entry) throw new IssuerError(`MPT issuance ${this.issuanceId} no longer exists`)
    return entry
  }

  private async requireOptedIn(address: string): Promise<MPTokenEntry> {
    const entry = await this.fetchHolder(address)
    if (!entry) {
      throw new ComplianceViolationError('HOLDER_NOT_OPTED_IN', `${address} has not opted in to ${this.issuanceId}`)
    }
    return entry
  }

  private async assertNotBanned(address: string): Promise<void> {
    if (await this.isBanned(address)) throw new ComplianceViolationError('HOLDER_BANNED', `${address} is banned`)
  }

  private assertHolderAddress(address: string): void {
    if (typeof address !== 'string' || !isValidClassicAddress(address)) {
      throw new InvalidInputError(`Invalid classic address: ${String(address)}`)
    }
    if (address === this.issuerAddress) throw new InvalidInputError('The issuer cannot be a holder of its own token')
  }

  private fetchHolder(address: string): Promise<MPTokenEntry | undefined> {
    return fetchEntry<MPTokenEntry>(this.options.client, {
      mptoken: { mpt_issuance_id: this.issuanceId, account: address },
    })
  }

  private async emit(event: Omit<AuditEvent, 'issuanceId' | 'timestamp'>): Promise<void> {
    if (!this.options.audit) return
    try {
      await this.options.audit({ ...event, issuanceId: this.issuanceId, timestamp: new Date().toISOString() })
    } catch (error) {
      console.error('Audit sink failed for event', event, error)
    }
  }
}

type IssuanceEntry = LedgerEntry.MPTokenIssuance
type MPTokenEntry = LedgerEntry.MPToken

function requireReason(reason: unknown): void {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new InvalidInputError('A non-empty reason is required for this compliance action')
  }
}

async function assertNetwork(options: IssuerOptions): Promise<void> {
  if (options.expectedNetworkId === undefined) return
  const info = await options.client.request({ command: 'server_info' })
  const actual = info.result.info.network_id ?? 0
  if (actual !== options.expectedNetworkId) {
    throw new NetworkMismatchError(`Connected to network ${actual}, expected ${options.expectedNetworkId}`)
  }
}

function fetchIssuance(client: Client, issuanceId: string): Promise<IssuanceEntry | undefined> {
  return fetchEntry<IssuanceEntry>(client, { mpt_issuance: issuanceId })
}

/** Reads a ledger entry from the latest validated ledger. Returns undefined if it doesn't exist. */
async function fetchEntry<T>(
  client: Client,
  selector: { mpt_issuance: string } | { mptoken: { mpt_issuance_id: string; account: string } },
): Promise<T | undefined> {
  try {
    const response = await client.request({ command: 'ledger_entry', ledger_index: 'validated', ...selector })
    return response.result.node as T
  } catch (error) {
    if ((error as { data?: { error?: string } }).data?.error === 'entryNotFound') return undefined
    throw error
  }
}
