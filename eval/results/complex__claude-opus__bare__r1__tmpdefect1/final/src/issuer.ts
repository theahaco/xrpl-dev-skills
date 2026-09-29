import {
  encodeMPTokenMetadata,
  isValidClassicAddress,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  validateMPTokenMetadata,
  type Client,
  type LedgerEntry,
  type MPTokenMetadata,
  type SubmittableTransaction,
  type TransactionMetadata,
  type Wallet,
} from 'xrpl'
import { ledgerAmount, parsePositiveAmount, type MptAmountInput } from './amount.js'
import type { AuditAction, AuditEvent, AuditSink } from './audit.js'
import type { BanRecord, BanStore } from './banStore.js'
import {
  BanEnforcementError,
  BannedHolderError,
  FrozenError,
  HolderStateError,
  InvalidArgumentError,
  IssuanceConfigError,
  IssuerError,
} from './errors.js'
import { SerialQueue, submitAndConfirm } from './submit.js'

/** Flags on an MPTokenIssuance ledger entry. */
export const IssuanceFlags = {
  lsfMPTLocked: 0x01,
  lsfMPTCanLock: 0x02,
  lsfMPTRequireAuth: 0x04,
  lsfMPTCanEscrow: 0x08,
  lsfMPTCanTrade: 0x10,
  lsfMPTCanTransfer: 0x20,
  lsfMPTCanClawback: 0x40,
  lsfMPTCanHoldConfidentialBalance: 0x80,
} as const

/** Flags on a holder's MPToken ledger entry. */
export const MPTokenFlags = {
  lsfMPTLocked: 0x01,
  lsfMPTAuthorized: 0x02,
} as const

/** Capabilities every issuance managed by this module must have. */
const REQUIRED_FLAGS = {
  lsfMPTCanLock: IssuanceFlags.lsfMPTCanLock,
  lsfMPTRequireAuth: IssuanceFlags.lsfMPTRequireAuth,
  lsfMPTCanClawback: IssuanceFlags.lsfMPTCanClawback,
} as const

/**
 * Capabilities that would let balances leave the reach of clawback, freeze or bans
 * (escrowed, DEX/AMM-held or encrypted balances), so they must be off.
 */
const FORBIDDEN_FLAGS = {
  lsfMPTCanEscrow: IssuanceFlags.lsfMPTCanEscrow,
  lsfMPTCanTrade: IssuanceFlags.lsfMPTCanTrade,
  lsfMPTCanHoldConfidentialBalance: IssuanceFlags.lsfMPTCanHoldConfidentialBalance,
} as const

const MAX_ASSET_SCALE = 19
const MAX_METADATA_BYTES = 1024

export interface CreateIssuanceOptions {
  /** Number of decimal places between the base unit and the display unit. Default 0. */
  assetScale?: number
  /** Supply cap in base units. Defaults to the ledger maximum. */
  maximumAmount?: MptAmountInput
  /** XLS-89 token metadata. */
  metadata?: MPTokenMetadata
  /** Whether approved holders may send the token to each other (not just to/from the issuer). Default true. */
  allowHolderTransfers?: boolean
}

export interface IssuerOptions {
  banStore: BanStore
  audit?: AuditSink
}

export interface IssuanceState {
  issuanceId: string
  issuer: string
  globallyFrozen: boolean
  canTransfer: boolean
  outstandingAmount: bigint
  maximumAmount: bigint | undefined
  assetScale: number
  flags: number
}

export interface HolderState {
  holder: string
  /** Whether the holder has opted in (an MPToken entry exists). */
  optedIn: boolean
  /** Approved by the issuer (on the allowlist). */
  authorized: boolean
  /** Individually frozen. Does not reflect a global freeze; see {@link IssuanceState.globallyFrozen}. */
  frozen: boolean
  balance: bigint
  /** Amount held in escrow (not spendable, not reachable by clawback). */
  lockedAmount: bigint
  banned: boolean
}

export interface BanResult {
  record: BanRecord
  clawedBack: bigint
}

/** Serializes all transactions signed by the same issuer account within this process. */
const queues = new Map<string, SerialQueue>()
function queueFor(address: string): SerialQueue {
  let queue = queues.get(address)
  if (!queue) {
    queue = new SerialQueue()
    queues.set(address, queue)
  }
  return queue
}

/**
 * Issuer-side compliance controls for one XRPL Multi-Purpose Token issuance.
 *
 * All amounts are in base units (integers). Every mutating call submits its transaction(s),
 * waits for a validated result, and throws on anything other than success. Calls on the same
 * issuer account are serialized within this process; do not sign with the issuer key from
 * another process at the same time.
 */
export class MptIssuer {
  private readonly queue: SerialQueue

  private constructor(
    private readonly client: Client,
    private readonly wallet: Wallet,
    readonly issuanceId: string,
    private readonly options: IssuerOptions,
  ) {
    this.queue = queueFor(wallet.classicAddress)
  }

  get issuer(): string {
    return this.wallet.classicAddress
  }

  /**
   * Creates a new issuance with allowlisting (RequireAuth), locking (per-holder and global) and
   * clawback enabled, and with escrow, DEX trading and confidential balances disabled.
   * These flags are fixed for the life of the issuance.
   */
  static async create(
    client: Client,
    wallet: Wallet,
    create: CreateIssuanceOptions,
    options: IssuerOptions,
  ): Promise<MptIssuer> {
    const assetScale = create.assetScale ?? 0
    if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > MAX_ASSET_SCALE) {
      throw new InvalidArgumentError(`assetScale must be an integer between 0 and ${MAX_ASSET_SCALE}`)
    }

    let flags =
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback
    if (create.allowHolderTransfers ?? true) flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer

    const tx: SubmittableTransaction = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      AssetScale: assetScale,
      Flags: flags,
    }
    if (create.maximumAmount !== undefined) {
      tx.MaximumAmount = parsePositiveAmount(create.maximumAmount, 'maximumAmount').toString()
    }
    if (create.metadata !== undefined) {
      tx.MPTokenMetadata = encodeMetadata(create.metadata)
    }

    const submitted = await queueFor(wallet.classicAddress).run(() => submitAndConfirm(client, wallet, tx))
    const issuanceId = (submitted.meta as TransactionMetadata & { mpt_issuance_id?: string }).mpt_issuance_id
    if (typeof issuanceId !== 'string') {
      throw new IssuerError(`MPTokenIssuanceCreate ${submitted.hash} succeeded but returned no mpt_issuance_id`)
    }
    const issuer = new MptIssuer(client, wallet, issuanceId, options)
    await issuer.emit({
      action: 'createIssuance',
      outcome: 'success',
      txHashes: [submitted.hash],
      detail: `flags=0x${flags.toString(16)} assetScale=${assetScale}`,
    })
    await issuer.verifyConfiguration()
    return issuer
  }

  /** Attaches to an existing issuance, verifying that the wallet is its issuer and that it is configured correctly. */
  static async load(client: Client, wallet: Wallet, issuanceId: string, options: IssuerOptions): Promise<MptIssuer> {
    if (!/^[0-9A-F]{48}$/i.test(issuanceId)) {
      throw new InvalidArgumentError(`Invalid MPT issuance ID: ${issuanceId}`)
    }
    const issuer = new MptIssuer(client, wallet, issuanceId.toUpperCase(), options)
    await issuer.verifyConfiguration()
    return issuer
  }

  /**
   * Checks the issuance on the validated ledger: it must be issued by this wallet, have the
   * compliance capabilities enabled, have no escape-hatch capabilities enabled, and not be
   * gated by a permissioned domain (which would let domain credentials stand in for our allowlist).
   */
  async verifyConfiguration(): Promise<IssuanceState> {
    const entry = await this.fetchIssuance()
    const problems: string[] = []
    if (entry.Issuer !== this.issuer) {
      problems.push(`issued by ${entry.Issuer}, not ${this.issuer}`)
    }
    for (const [name, bit] of Object.entries(REQUIRED_FLAGS)) {
      if ((entry.Flags & bit) === 0) problems.push(`${name} is not set`)
    }
    for (const [name, bit] of Object.entries(FORBIDDEN_FLAGS)) {
      if ((entry.Flags & bit) !== 0) problems.push(`${name} is set`)
    }
    if (entry.DomainID !== undefined) {
      problems.push(`DomainID ${entry.DomainID} is set`)
    }
    if (problems.length > 0) {
      throw new IssuanceConfigError(`Issuance ${this.issuanceId} is not usable: ${problems.join('; ')}`)
    }
    return toIssuanceState(this.issuanceId, entry)
  }

  async getIssuanceState(): Promise<IssuanceState> {
    return toIssuanceState(this.issuanceId, await this.fetchIssuance())
  }

  async getHolderState(holder: string): Promise<HolderState> {
    this.assertHolderAddress(holder)
    const [token, ban] = await Promise.all([this.fetchMPToken(holder), this.options.banStore.get(this.issuanceId, holder)])
    return {
      holder,
      optedIn: token !== undefined,
      authorized: token !== undefined && (token.Flags & MPTokenFlags.lsfMPTAuthorized) !== 0,
      frozen: token !== undefined && (token.Flags & MPTokenFlags.lsfMPTLocked) !== 0,
      balance: ledgerAmount(token?.MPTAmount),
      lockedAmount: ledgerAmount(token?.LockedAmount),
      banned: ban !== undefined,
    }
  }

  async isBanned(holder: string): Promise<boolean> {
    this.assertHolderAddress(holder)
    return (await this.options.banStore.get(this.issuanceId, holder)) !== undefined
  }

  listBans(): Promise<BanRecord[]> {
    return this.options.banStore.list(this.issuanceId)
  }

  /**
   * Adds a holder to the allowlist, after KYC. The holder must first opt in to the token
   * (submit an MPTokenAuthorize from their own account). Banned holders are refused.
   */
  approveHolder(holder: string): Promise<void> {
    return this.act('approveHolder', { holder }, async (submit) => {
      await this.assertNotBanned(holder)
      await this.verifyConfiguration()
      const state = await this.getHolderState(holder)
      if (!state.optedIn) {
        throw new HolderStateError(holder, `Holder ${holder} has not opted in to ${this.issuanceId}`)
      }
      if (state.authorized) return 'noop'
      await submit({
        TransactionType: 'MPTokenAuthorize',
        Account: this.issuer,
        MPTokenIssuanceID: this.issuanceId,
        Holder: holder,
      })
      return 'success'
    })
  }

  /**
   * Removes a holder from the allowlist. They can no longer send or receive the token, but keep
   * any balance (use {@link clawback} or {@link ban} to remove it).
   */
  revokeApproval(holder: string): Promise<void> {
    return this.act('revokeApproval', { holder }, async (submit) => {
      const state = await this.getHolderState(holder)
      if (!state.authorized) return 'noop'
      await this.submitUnauthorize(submit, holder)
      return 'success'
    })
  }

  /**
   * Sends newly issued tokens to an approved holder. Refused if the holder is banned or frozen,
   * or the token is globally frozen. (The ledger itself lets the issuer pay a locked holder, so
   * this check is what makes a freeze cover issuance. Approval is enforced by the ledger.)
   */
  issue(holder: string, amount: MptAmountInput): Promise<void> {
    const value = parsePositiveAmount(amount)
    return this.act('issue', { holder, amount: value }, async (submit) => {
      await this.assertNotBanned(holder)
      const [issuance, state] = await Promise.all([this.getIssuanceState(), this.getHolderState(holder)])
      if (issuance.globallyFrozen) throw new FrozenError('global')
      if (state.frozen) throw new FrozenError('holder', holder)
      await submit({
        TransactionType: 'Payment',
        Account: this.issuer,
        Destination: holder,
        Amount: { mpt_issuance_id: this.issuanceId, value: value.toString() },
      })
      return 'success'
    })
  }

  /**
   * Claws back `amount` from a holder, returning it to the issuer (it leaves circulation).
   * Refuses if the holder's balance is lower than `amount`. Works on frozen and unapproved holders.
   * Resolves with the amount actually clawed back, read from the transaction metadata.
   */
  clawback(holder: string, amount: MptAmountInput): Promise<bigint> {
    const value = parsePositiveAmount(amount)
    return this.act('clawback', { holder, amount: value }, async (submit) => {
      const { balance } = await this.getHolderState(holder)
      if (balance < value) {
        throw new HolderStateError(holder, `Holder ${holder} has ${balance}, cannot claw back ${value}`)
      }
      return { outcome: 'success', result: await this.submitClawback(submit, holder, value) }
    })
  }

  /**
   * Freezes one holder until unfrozen. The ledger rejects transfers between the holder and other
   * holders, and {@link issue} refuses to pay them.
   *
   * By XRPL design a frozen holder can still send the token back to the issuer (redeem). That
   * does not move value to anyone else, but redemption processing must check
   * {@link getHolderState} and not pay out for tokens returned by a frozen holder.
   */
  freezeHolder(holder: string): Promise<void> {
    return this.setHolderLock('freezeHolder', holder, true)
  }

  unfreezeHolder(holder: string): Promise<void> {
    return this.setHolderLock('unfreezeHolder', holder, false)
  }

  /**
   * Freezes all movement of the token: the ledger rejects every transfer between holders, and
   * {@link issue} refuses to pay anyone. Clawback still works. As with {@link freezeHolder},
   * holders can still send the token back to the issuer.
   */
  freezeAll(): Promise<void> {
    return this.setGlobalLock('freezeAll', true)
  }

  unfreezeAll(): Promise<void> {
    return this.setGlobalLock('unfreezeAll', false)
  }

  /**
   * Bans a holder: records the ban durably (so they can never be re-approved or issued to by this
   * module), removes them from the allowlist (so the ledger rejects any transfer to or from them),
   * then claws back their entire balance. Finally re-reads the ledger to confirm the holder is
   * unapproved with a zero balance.
   *
   * Idempotent: calling it again for a banned holder re-runs and re-verifies enforcement, which
   * is how to recover from a {@link BanEnforcementError}.
   */
  ban(holder: string, reason: string): Promise<BanResult> {
    return this.act('ban', { holder }, async (submit) => {
      if (reason.trim() === '') throw new InvalidArgumentError('A ban reason is required')
      // Record first so that, whatever happens next, this module refuses the holder.
      await this.options.banStore.add({ issuanceId: this.issuanceId, holder, reason, bannedAt: new Date().toISOString() })
      const record = await this.options.banStore.get(this.issuanceId, holder)
      if (!record) throw new BanEnforcementError(holder, `Ban for ${holder} was not persisted by the ban store`)
      await this.verifyConfiguration()

      let clawedBack = 0n
      try {
        let state = await this.getHolderState(holder)
        // Revoke first: from this point the ledger rejects every transfer to or from the holder,
        // so the balance can only go down while we claw it back.
        if (state.authorized) await this.submitUnauthorize(submit, holder)
        for (let attempt = 0; attempt < 3 && state.balance > 0n; attempt++) {
          clawedBack += await this.submitClawback(submit, holder, state.balance)
          state = await this.getHolderState(holder)
        }
        const problems: string[] = []
        if (state.authorized) problems.push('still authorized')
        if (state.balance !== 0n) problems.push(`balance is ${state.balance}`)
        if (state.lockedAmount !== 0n) problems.push(`${state.lockedAmount} is held in escrow`)
        if (problems.length > 0) {
          throw new BanEnforcementError(holder, `Ban recorded but not enforced for ${holder}: ${problems.join(', ')}`)
        }
      } catch (error) {
        if (error instanceof BanEnforcementError) throw error
        throw new BanEnforcementError(holder, `Ban recorded but enforcement failed for ${holder}: ${String(error)}`, {
          cause: error,
        })
      }
      return { outcome: 'success', result: { record, clawedBack }, detail: `reason=${reason}; clawedBack=${clawedBack}` }
    })
  }

  // --- internals -----------------------------------------------------------------------------

  private setHolderLock(action: AuditAction, holder: string, lock: boolean): Promise<void> {
    return this.act(action, { holder }, async (submit) => {
      const state = await this.getHolderState(holder)
      if (!state.optedIn) {
        throw new HolderStateError(holder, `Holder ${holder} has no MPToken for ${this.issuanceId}; nothing to ${action}`)
      }
      if (state.frozen === lock) return 'noop'
      await submit({
        TransactionType: 'MPTokenIssuanceSet',
        Account: this.issuer,
        MPTokenIssuanceID: this.issuanceId,
        Holder: holder,
        Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
      })
      return 'success'
    })
  }

  private setGlobalLock(action: AuditAction, lock: boolean): Promise<void> {
    return this.act(action, {}, async (submit) => {
      const state = await this.getIssuanceState()
      if (state.globallyFrozen === lock) return 'noop'
      await submit({
        TransactionType: 'MPTokenIssuanceSet',
        Account: this.issuer,
        MPTokenIssuanceID: this.issuanceId,
        Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
      })
      return 'success'
    })
  }

  private async submitUnauthorize(submit: Submit, holder: string): Promise<void> {
    await submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuer,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
  }

  private async submitClawback(submit: Submit, holder: string, amount: bigint): Promise<bigint> {
    const { meta } = await submit({
      TransactionType: 'Clawback',
      Account: this.issuer,
      Holder: holder,
      Amount: { mpt_issuance_id: this.issuanceId, value: amount.toString() },
    })
    return this.balanceDecrease(meta, holder)
  }

  /** How much a holder's MPToken balance went down in a transaction. */
  private balanceDecrease(meta: TransactionMetadata, holder: string): bigint {
    for (const node of meta.AffectedNodes) {
      if (!('ModifiedNode' in node)) continue
      const { LedgerEntryType, FinalFields, PreviousFields } = node.ModifiedNode
      if (
        LedgerEntryType === 'MPToken' &&
        FinalFields?.['Account'] === holder &&
        FinalFields['MPTokenIssuanceID'] === this.issuanceId
      ) {
        if (PreviousFields === undefined || !('MPTAmount' in PreviousFields)) return 0n
        return ledgerAmount(PreviousFields['MPTAmount']) - ledgerAmount(FinalFields['MPTAmount'])
      }
    }
    return 0n
  }

  /**
   * Runs a mutating action on the issuer's serial queue, collecting the hashes of the
   * transactions it submits, and emits exactly one audit event for it.
   */
  private act<T = void>(
    action: AuditAction,
    fields: { holder?: string; amount?: bigint },
    body: (submit: Submit) => Promise<'success' | 'noop' | { outcome: 'success'; result: T; detail?: string }>,
  ): Promise<T> {
    return this.queue.run(async () => {
      const txHashes: string[] = []
      const base = {
        action,
        ...(fields.holder !== undefined && { holder: fields.holder }),
        ...(fields.amount !== undefined && { amount: fields.amount.toString() }),
        txHashes,
      }
      const submit: Submit = async (tx) => {
        const submitted = submitAndConfirm(this.client, this.wallet, tx)
        try {
          const result = await submitted
          txHashes.push(result.hash)
          return result
        } catch (error) {
          const hash = (error as { hash?: unknown }).hash
          if (typeof hash === 'string') txHashes.push(hash)
          throw error
        }
      }
      let outcome: Awaited<ReturnType<typeof body>>
      try {
        if (fields.holder !== undefined) this.assertHolderAddress(fields.holder)
        outcome = await body(submit)
      } catch (error) {
        try {
          await this.emit({ ...base, outcome: 'error', detail: error instanceof Error ? error.message : String(error) })
        } catch (auditError) {
          throw new AggregateError([error, auditError], `${action} failed and its audit event could not be recorded`)
        }
        throw error
      }
      if (typeof outcome === 'string') {
        await this.emit({ ...base, outcome })
        return undefined as T
      }
      await this.emit({ ...base, outcome: 'success', ...(outcome.detail !== undefined && { detail: outcome.detail }) })
      return outcome.result
    })
  }

  private async emit(event: Omit<AuditEvent, 'timestamp' | 'issuanceId'>): Promise<void> {
    await this.options.audit?.({ timestamp: new Date().toISOString(), issuanceId: this.issuanceId, ...event })
  }

  private assertHolderAddress(holder: string): void {
    if (!isValidClassicAddress(holder)) {
      throw new InvalidArgumentError(`Not a valid classic address: ${JSON.stringify(holder)}`)
    }
    if (holder === this.issuer) {
      throw new InvalidArgumentError('The issuer cannot be a holder of its own token')
    }
  }

  private async assertNotBanned(holder: string): Promise<void> {
    if (await this.isBanned(holder)) throw new BannedHolderError(holder)
  }

  private async fetchIssuance(): Promise<LedgerEntry.MPTokenIssuance> {
    const node = await this.fetchEntry({ mpt_issuance: this.issuanceId })
    if (!node) throw new IssuanceConfigError(`Issuance ${this.issuanceId} not found on the validated ledger`)
    return node as LedgerEntry.MPTokenIssuance
  }

  private async fetchMPToken(holder: string): Promise<LedgerEntry.MPToken | undefined> {
    const node = await this.fetchEntry({ mptoken: { mpt_issuance_id: this.issuanceId, account: holder } })
    return node as LedgerEntry.MPToken | undefined
  }

  private async fetchEntry(
    query: { mpt_issuance: string } | { mptoken: { mpt_issuance_id: string; account: string } },
  ): Promise<unknown> {
    try {
      const response = await this.client.request({ command: 'ledger_entry', ledger_index: 'validated', ...query })
      return response.result.node
    } catch (error) {
      if ((error as { data?: { error?: string } }).data?.error === 'entryNotFound') return undefined
      throw error
    }
  }
}

type Submit = (tx: SubmittableTransaction) => ReturnType<typeof submitAndConfirm>

function encodeMetadata(metadata: MPTokenMetadata): string {
  const hex = encodeMPTokenMetadata(metadata)
  const problems = validateMPTokenMetadata(hex)
  if (problems.length > 0) {
    throw new InvalidArgumentError(`Token metadata is not valid XLS-89: ${problems.join('; ')}`)
  }
  if (hex.length / 2 > MAX_METADATA_BYTES) {
    throw new InvalidArgumentError(`Token metadata exceeds ${MAX_METADATA_BYTES} bytes`)
  }
  return hex
}

function toIssuanceState(issuanceId: string, entry: LedgerEntry.MPTokenIssuance): IssuanceState {
  return {
    issuanceId,
    issuer: entry.Issuer,
    globallyFrozen: (entry.Flags & IssuanceFlags.lsfMPTLocked) !== 0,
    canTransfer: (entry.Flags & IssuanceFlags.lsfMPTCanTransfer) !== 0,
    outstandingAmount: ledgerAmount(entry.OutstandingAmount),
    maximumAmount: entry.MaximumAmount === undefined ? undefined : ledgerAmount(entry.MaximumAmount),
    assetScale: entry.AssetScale ?? 0,
    flags: entry.Flags,
  }
}
