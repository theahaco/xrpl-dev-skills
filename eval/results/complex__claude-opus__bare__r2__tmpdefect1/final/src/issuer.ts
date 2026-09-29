import {
  encodeMPTokenMetadata,
  isValidClassicAddress,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceSetFlags,
  type Client,
  type MPTokenIssuanceCreate,
  type MPTokenMetadata,
  type SubmittableTransaction,
  type Wallet,
} from 'xrpl'

import { ledgerAmount, MAX_MPT_AMOUNT, parseAmount, type AmountInput } from './amount.js'
import type { BanRecord, BanRegistry } from './ban-registry.js'
import { ComplianceError, InvalidInputError, IssuanceConfigError, MptIssuerError } from './errors.js'
import { holderDebit, isAmendmentEnabled, readHolder, readIssuance } from './ledger.js'
import { silentLogger, type Logger } from './logger.js'
import { creationFlags, HolderFlag, IssuanceFlag, issuanceProblems, PINNED_IMMUTABLE_FLAGS } from './policy.js'
import { TransactionSubmitter, type SubmitterOptions, type ValidatedTransaction } from './submitter.js'

export type AuditAction =
  | 'CREATE_ISSUANCE'
  | 'APPROVE_HOLDER'
  | 'REVOKE_APPROVAL'
  | 'ISSUE'
  | 'CLAWBACK'
  | 'FREEZE_HOLDER'
  | 'UNFREEZE_HOLDER'
  | 'FREEZE_GLOBAL'
  | 'UNFREEZE_GLOBAL'
  | 'BAN_RECORDED'
  | 'BAN_COMPLETED'

export interface AuditEvent {
  action: AuditAction
  issuanceId: string
  holder?: string
  /** Integer base units, as a string. */
  amount?: string
  txHash?: string
  ledgerIndex?: number
  detail?: string
  at: string
}

export interface MptIssuerOptions {
  /** Durable record of banned addresses. Required: bans must survive restarts. */
  banRegistry: BanRegistry
  logger?: Logger
  /**
   * Receives one event per validated state change. The ledger action has
   * already happened when this runs, so a throwing sink is logged (with the
   * full event) rather than propagated. Otherwise a caller could retry an
   * action that already succeeded.
   */
  audit?: (event: AuditEvent) => void | Promise<void>
  submitter?: SubmitterOptions
}

export interface CreateIssuanceParams {
  /** Decimal places: 1 token = 10^assetScale base units. All amounts in this API are base units. */
  assetScale: number
  /** Cap on OutstandingAmount, in base units. Defaults to the ledger maximum. */
  maximumAmount?: AmountInput
  /** XLS-89 metadata (ticker, name, issuer_name, …). */
  metadata?: MPTokenMetadata
  /** Allow holder-to-holder transfers (subject to allowlist and freezes). Default true. */
  allowHolderTransfers?: boolean
}

export interface IssuanceState {
  issuanceId: string
  issuer: string
  assetScale: number
  outstanding: bigint
  maximum: bigint
  globallyFrozen: boolean
}

export interface HolderState {
  address: string
  /** The holder has created its MPToken entry (a prerequisite for approval). */
  optedIn: boolean
  authorized: boolean
  frozen: boolean
  balance: bigint
  banned: boolean
}

export interface ActionResult {
  /** False when the ledger was already in the requested state and nothing was submitted. */
  changed: boolean
  txHash?: string
  ledgerIndex?: number
}

export interface AmountResult extends ActionResult {
  amount: bigint
}

export interface BanResult {
  record: BanRecord
  clawedBack: bigint
  txHashes: string[]
}

/**
 * Issuer-side controls for a single regulated MPT issuance.
 *
 * Each operation checks the current validated ledger state and our own
 * policy first. It submits nothing if the request would break a compliance
 * rule. The ledger enforces the same rules again, so a policy check that
 * races with another change still can't produce a non-compliant state.
 */
export class MptIssuer {
  private readonly logger: Logger

  private constructor(
    private readonly client: Client,
    private readonly submitter: TransactionSubmitter,
    readonly issuanceId: string,
    private readonly options: MptIssuerOptions,
  ) {
    this.logger = options.logger ?? silentLogger
  }

  get issuerAddress(): string {
    return this.submitter.wallet.classicAddress
  }

  /** Creates a new issuance with all compliance controls enabled, and attaches to it. */
  static async create(
    client: Client,
    wallet: Wallet,
    params: CreateIssuanceParams,
    options: MptIssuerOptions,
  ): Promise<MptIssuer> {
    const logger = options.logger ?? silentLogger
    if (!Number.isInteger(params.assetScale) || params.assetScale < 0 || params.assetScale > 19) {
      throw new InvalidInputError(`assetScale must be an integer in [0, 19], got ${params.assetScale}`)
    }

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      AssetScale: params.assetScale,
      Flags: creationFlags(params.allowHolderTransfers ?? true),
    }
    if (params.maximumAmount !== undefined) {
      tx.MaximumAmount = parseAmount(params.maximumAmount, 'maximumAmount').toString()
    }
    if (params.metadata !== undefined) {
      tx.MPTokenMetadata = encodeMPTokenMetadata(params.metadata)
    }

    // Without DynamicMPT, issuance flags can't be changed at all. With it,
    // they're mutable unless pinned at creation, so pin them.
    const dynamic = await isAmendmentEnabled(client, 'DynamicMPT')
    if (dynamic === true) {
      tx.ImmutableFlags = PINNED_IMMUTABLE_FLAGS
    } else if (dynamic === undefined) {
      logger.warn?.('could not determine whether DynamicMPT is enabled; issuance flags are not pinned')
    }

    const submitter = new TransactionSubmitter(client, wallet, logger, options.submitter)
    const result = await submitter.submit(tx)
    const issuanceId = (result.meta as { mpt_issuance_id?: string }).mpt_issuance_id
    if (issuanceId === undefined) {
      throw new MptIssuerError(`MPTokenIssuanceCreate ${result.hash} succeeded but returned no mpt_issuance_id`)
    }

    const issuer = new MptIssuer(client, submitter, issuanceId, options)
    await issuer.emit({ action: 'CREATE_ISSUANCE', txHash: result.hash, ledgerIndex: result.ledgerIndex })
    await issuer.assertCompliantIssuance()
    return issuer
  }

  /** Attaches to an existing issuance, refusing to operate it unless its configuration is compliant. */
  static async attach(
    client: Client,
    wallet: Wallet,
    issuanceId: string,
    options: MptIssuerOptions,
  ): Promise<MptIssuer> {
    if (!/^[0-9A-F]{48}$/.test(issuanceId)) {
      throw new InvalidInputError(`not a valid MPT issuance ID: ${issuanceId}`)
    }
    const submitter = new TransactionSubmitter(client, wallet, options.logger ?? silentLogger, options.submitter)
    const issuer = new MptIssuer(client, submitter, issuanceId, options)
    await issuer.assertCompliantIssuance()
    return issuer
  }

  /** Throws IssuanceConfigError unless the issuance has every required control and no escape hatch. */
  async assertCompliantIssuance(): Promise<void> {
    const entry = await readIssuance(this.client, this.issuanceId)
    if (entry === undefined) throw new IssuanceConfigError(this.issuanceId, ['issuance does not exist'])
    const problems = issuanceProblems(entry, this.issuerAddress)
    if (problems.length > 0) throw new IssuanceConfigError(this.issuanceId, problems)
  }

  // ---------------------------------------------------------------- reads

  async getIssuance(): Promise<IssuanceState> {
    const entry = await readIssuance(this.client, this.issuanceId)
    if (entry === undefined) throw new IssuanceConfigError(this.issuanceId, ['issuance does not exist'])
    return {
      issuanceId: this.issuanceId,
      issuer: entry.Issuer,
      assetScale: entry.AssetScale ?? 0,
      outstanding: ledgerAmount(entry.OutstandingAmount),
      maximum: entry.MaximumAmount === undefined ? MAX_MPT_AMOUNT : BigInt(entry.MaximumAmount),
      globallyFrozen: (entry.Flags & IssuanceFlag.Locked) !== 0,
    }
  }

  async getHolder(address: string): Promise<HolderState> {
    this.assertHolderAddress(address)
    const [entry, ban] = await Promise.all([
      readHolder(this.client, this.issuanceId, address),
      this.options.banRegistry.get(this.issuanceId, address),
    ])
    return {
      address,
      optedIn: entry !== undefined,
      authorized: entry !== undefined && (entry.Flags & HolderFlag.Authorized) !== 0,
      frozen: entry !== undefined && (entry.Flags & HolderFlag.Locked) !== 0,
      balance: ledgerAmount(entry?.MPTAmount),
      banned: ban !== undefined,
    }
  }

  // ------------------------------------------------------------ allowlist

  /**
   * Adds a KYC-approved holder to the allowlist. The holder must already
   * have opted in (created its MPToken entry). Banned addresses are refused.
   */
  async approveHolder(address: string): Promise<ActionResult> {
    const holder = await this.getHolder(address)
    if (holder.banned) throw this.refuse('HOLDER_BANNED', address, 'is banned and cannot be approved')
    if (!holder.optedIn) {
      throw this.refuse('HOLDER_NOT_OPTED_IN', address, 'must submit MPTokenAuthorize for this issuance before it can be approved')
    }
    if (holder.authorized) return { changed: false }
    const result = await this.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
    })
    await this.emit({ action: 'APPROVE_HOLDER', holder: address, txHash: result.hash, ledgerIndex: result.ledgerIndex })
    return changed(result)
  }

  /**
   * Removes a holder from the allowlist (e.g. expired KYC). The holder's
   * balance stays where it is but can't be sent or received until they're
   * approved again. Use ban() to also remove their tokens permanently.
   */
  async revokeApproval(address: string): Promise<ActionResult> {
    const holder = await this.getHolder(address)
    if (!holder.authorized) return { changed: false }
    const result = await this.submit(this.unauthorizeTx(address))
    await this.emit({ action: 'REVOKE_APPROVAL', holder: address, txHash: result.hash, ledgerIndex: result.ledgerIndex })
    return changed(result)
  }

  // ------------------------------------------------------------- issuance

  /**
   * Sends newly issued tokens to an approved holder.
   *
   * The ledger lets the issuer pay a frozen holder, and pay anyone during a
   * global freeze, so this method enforces both freezes itself.
   */
  async issue(address: string, amountInput: AmountInput): Promise<AmountResult> {
    const amount = parseAmount(amountInput)
    const [holder, issuance] = await Promise.all([this.getHolder(address), this.getIssuance()])
    if (holder.banned) throw this.refuse('HOLDER_BANNED', address, 'is banned')
    if (!holder.optedIn) throw this.refuse('HOLDER_NOT_OPTED_IN', address, 'has not opted in to this issuance')
    if (!holder.authorized) throw this.refuse('HOLDER_NOT_AUTHORIZED', address, 'is not on the allowlist')
    if (holder.frozen) throw this.refuse('HOLDER_FROZEN', address, 'is frozen')
    if (issuance.globallyFrozen) throw this.refuse('GLOBALLY_FROZEN', undefined, 'the token is globally frozen')

    const result = await this.submit({
      TransactionType: 'Payment',
      Account: this.issuerAddress,
      Destination: address,
      Amount: { mpt_issuance_id: this.issuanceId, value: amount.toString() },
    })
    const delivered = result.meta.delivered_amount
    if (typeof delivered !== 'object' || !('mpt_issuance_id' in delivered) || BigInt(delivered.value) !== amount) {
      // Should be impossible for a direct, non-partial MPT payment; surface it loudly if it happens.
      this.logger.error?.('issued amount does not match delivered amount', { txHash: result.hash, amount: amount.toString(), delivered })
    }
    await this.emit({ action: 'ISSUE', holder: address, amount: amount.toString(), txHash: result.hash, ledgerIndex: result.ledgerIndex })
    return { ...changed(result), amount }
  }

  // ------------------------------------------------------------- clawback

  /**
   * Claws back an exact amount from any holder, whether frozen, unapproved
   * or banned. The ledger would silently cap an oversized clawback at the
   * balance; we refuse instead so the audit trail shows exactly what was
   * requested.
   */
  async clawback(address: string, amountInput: AmountInput): Promise<AmountResult> {
    const amount = parseAmount(amountInput)
    const holder = await this.getHolder(address)
    if (holder.balance < amount) {
      throw this.refuse('INSUFFICIENT_BALANCE', address, `holds ${holder.balance}, cannot claw back ${amount}`)
    }
    return this.clawbackUnchecked(address, amount)
  }

  private async clawbackUnchecked(address: string, amount: bigint): Promise<AmountResult> {
    const result = await this.submit({
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Holder: address,
      Amount: { mpt_issuance_id: this.issuanceId, value: amount.toString() },
    })
    const clawed = holderDebit(result.meta, this.issuanceId, address)
    await this.emit({ action: 'CLAWBACK', holder: address, amount: clawed.toString(), txHash: result.hash, ledgerIndex: result.ledgerIndex })
    return { ...changed(result), amount: clawed }
  }

  // --------------------------------------------------------------- freeze

  /**
   * Freezes one holder: the ledger rejects any transfer to or from them
   * with other holders.
   *
   * Protocol caveat: a frozen holder can still send tokens back to the
   * issuer (a redemption). issue() refuses to pay frozen holders.
   */
  async freezeHolder(address: string): Promise<ActionResult> {
    const holder = await this.getHolder(address)
    if (!holder.optedIn) throw this.refuse('HOLDER_NOT_OPTED_IN', address, 'has no MPToken entry to freeze')
    if (holder.frozen) return { changed: false }
    const result = await this.submit(this.lockTx(MPTokenIssuanceSetFlags.tfMPTLock, address))
    await this.emit({ action: 'FREEZE_HOLDER', holder: address, txHash: result.hash, ledgerIndex: result.ledgerIndex })
    return changed(result)
  }

  async unfreezeHolder(address: string): Promise<ActionResult> {
    const holder = await this.getHolder(address)
    if (holder.banned) throw this.refuse('HOLDER_BANNED', address, 'is banned and stays frozen')
    if (!holder.optedIn || !holder.frozen) return { changed: false }
    const result = await this.submit(this.lockTx(MPTokenIssuanceSetFlags.tfMPTUnlock, address))
    await this.emit({ action: 'UNFREEZE_HOLDER', holder: address, txHash: result.hash, ledgerIndex: result.ledgerIndex })
    return changed(result)
  }

  /**
   * Freezes the whole token: the ledger rejects every holder-to-holder
   * transfer. Clawback keeps working. Same caveat as freezeHolder(): holders
   * can still redeem to the issuer, and issue() refuses while frozen.
   */
  async freezeGlobal(): Promise<ActionResult> {
    if ((await this.getIssuance()).globallyFrozen) return { changed: false }
    const result = await this.submit(this.lockTx(MPTokenIssuanceSetFlags.tfMPTLock))
    await this.emit({ action: 'FREEZE_GLOBAL', txHash: result.hash, ledgerIndex: result.ledgerIndex })
    return changed(result)
  }

  async unfreezeGlobal(): Promise<ActionResult> {
    if (!(await this.getIssuance()).globallyFrozen) return { changed: false }
    const result = await this.submit(this.lockTx(MPTokenIssuanceSetFlags.tfMPTUnlock))
    await this.emit({ action: 'UNFREEZE_GLOBAL', txHash: result.hash, ledgerIndex: result.ledgerIndex })
    return changed(result)
  }

  // ------------------------------------------------------------------ ban

  /**
   * Bans an address permanently:
   *   1. records the ban durably (before touching the ledger, so a crash
   *      midway can never leave the address approvable),
   *   2. freezes the holder,
   *   3. revokes approval, which blocks all transfers in either direction,
   *      including redemptions to the issuer,
   *   4. claws back the entire balance,
   *   5. re-reads the validated ledger and verifies the end state.
   *
   * Idempotent: calling it again finishes a partially completed ban.
   */
  async ban(address: string, reason: string): Promise<BanResult> {
    this.assertHolderAddress(address)
    if (reason.trim() === '') throw new InvalidInputError('a ban requires a reason')

    const registry = this.options.banRegistry
    const record: BanRecord = (await registry.get(this.issuanceId, address)) ?? {
      issuanceId: this.issuanceId,
      address,
      reason,
      bannedAt: new Date().toISOString(),
    }
    await registry.add(record)
    await this.emit({ action: 'BAN_RECORDED', holder: address, detail: record.reason })

    const txHashes: string[] = []
    let clawedBack = 0n
    let holder = await this.getHolder(address)

    if (holder.optedIn) {
      if (!holder.frozen) {
        const r = await this.freezeHolder(address)
        if (r.txHash !== undefined) txHashes.push(r.txHash)
      }
      if (holder.authorized) {
        const r = await this.revokeApproval(address)
        if (r.txHash !== undefined) txHashes.push(r.txHash)
      }
      // The holder can no longer move tokens, so its balance can't change
      // under us; the loop just covers a failed attempt.
      for (let attempt = 0; attempt < 3; attempt++) {
        holder = await this.getHolder(address)
        if (holder.balance === 0n) break
        const r = await this.clawbackUnchecked(address, holder.balance)
        clawedBack += r.amount
        if (r.txHash !== undefined) txHashes.push(r.txHash)
      }
      holder = await this.getHolder(address)
    }

    const violations: string[] = []
    if (holder.balance !== 0n) violations.push(`balance is ${holder.balance}`)
    if (holder.authorized) violations.push('still authorized')
    if (holder.optedIn && !holder.frozen) violations.push('not frozen')
    if (violations.length > 0) {
      throw new MptIssuerError(`ban of ${address} did not reach its end state: ${violations.join(', ')}. Re-run ban().`)
    }

    await this.emit({ action: 'BAN_COMPLETED', holder: address, amount: clawedBack.toString(), detail: record.reason })
    return { record, clawedBack, txHashes }
  }

  // -------------------------------------------------------------- helpers

  private lockTx(flag: number, holder?: string): SubmittableTransaction {
    return {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Flags: flag,
      ...(holder !== undefined ? { Holder: holder } : {}),
    }
  }

  private unauthorizeTx(holder: string): SubmittableTransaction {
    return {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    }
  }

  private submit(tx: SubmittableTransaction): Promise<ValidatedTransaction> {
    return this.submitter.submit(tx)
  }

  private assertHolderAddress(address: string): void {
    if (!isValidClassicAddress(address)) throw new InvalidInputError(`not a valid classic address: ${address}`)
    if (address === this.issuerAddress) throw new InvalidInputError('the issuer cannot be a holder of its own token')
  }

  private refuse(reason: ConstructorParameters<typeof ComplianceError>[0], holder: string | undefined, message: string): ComplianceError {
    return new ComplianceError(reason, holder, holder === undefined ? message : `${holder} ${message}`)
  }

  private async emit(event: Omit<AuditEvent, 'issuanceId' | 'at'>): Promise<void> {
    const full: AuditEvent = { ...event, issuanceId: this.issuanceId, at: new Date().toISOString() }
    this.logger.info?.(`audit ${event.action}`, { ...full })
    if (this.options.audit === undefined) return
    try {
      await this.options.audit(full)
    } catch (error) {
      this.logger.error?.('audit sink failed; event must be recovered from this log', { event: full, error: String(error) })
    }
  }
}

function changed(result: ValidatedTransaction): ActionResult {
  return { changed: true, txHash: result.hash, ledgerIndex: result.ledgerIndex }
}
