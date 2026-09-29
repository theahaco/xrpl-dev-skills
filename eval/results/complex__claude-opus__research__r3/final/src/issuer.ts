import {
  encodeMPTokenMetadata,
  isValidClassicAddress,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  validateMPTokenMetadata,
  type Client,
  type Clawback,
  type MPTAmount,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type MPTokenIssuanceSet,
  type MPTokenMetadata,
  type Payment,
  type TransactionMetadata,
  type Wallet,
} from 'xrpl'

import { fromRawAmount, MAX_MPT_RAW, parseRaw, toRawAmount } from './amount.js'
import type { BanRecord, BanRegistry } from './banRegistry.js'
import {
  ComplianceViolationError,
  HolderNotOptedInError,
  InvalidInputError,
  IssuanceMisconfiguredError,
  PostConditionError,
} from './errors.js'
import {
  computeIssuanceId,
  normalizeIssuanceId,
  readHolder,
  readIssuance,
  type HolderLedgerState,
  type IssuanceState,
} from './ledger.js'
import { TransactionSubmitter, type TxReceipt } from './submit.js'

export interface AuditEvent {
  action:
    | 'issuance.create'
    | 'holder.approve'
    | 'holder.revoke'
    | 'holder.issue'
    | 'holder.clawback'
    | 'holder.freeze'
    | 'holder.unfreeze'
    | 'holder.ban'
    | 'issuance.freeze'
    | 'issuance.unfreeze'
  issuanceId: string
  holder?: string
  /** Human-readable token amount. */
  amount?: string
  txHash?: string
  ledgerIndex?: number
  detail?: string
}

export interface MptIssuerOptions {
  /** Durable ban list. Required: bans must survive restarts. */
  banRegistry: BanRegistry
  /** Reuse a submitter shared with other components signing for the same account. */
  submitter?: TransactionSubmitter
  /** If set, refuse to operate unless the connected network has this NetworkID (testnet = 1, mainnet = 0). */
  expectedNetworkId?: number
  /** Receives one event per successful ledger-changing operation (for the audit trail). */
  onAudit?: (event: AuditEvent) => void
}

export interface CreateIssuanceParams {
  /** Decimal places of one token unit (0-255). E.g. 2 means the smallest unit is 0.01. */
  assetScale: number
  /** XLS-89 metadata. Encoded to at most 1024 bytes. */
  metadata: MPTokenMetadata
  /** Optional hard cap on circulating supply, in token units. */
  maximumAmount?: string
  /** Allow approved holders to transfer to each other (tfMPTCanTransfer). Default true. */
  allowHolderTransfers?: boolean
}

/** Result of an idempotent operation: either it changed the ledger, or the ledger was already in the target state. */
export type OpResult = { changed: true; tx: TxReceipt } | { changed: false; reason: string }

export interface ClawbackResult {
  tx: TxReceipt
  /** Amount actually removed (token units). Can be less than requested if the balance was smaller. */
  clawedBack: string
}

export interface IssueResult {
  tx: TxReceipt
  delivered: string
}

export interface HolderStatus {
  address: string
  optedIn: boolean
  approved: boolean
  frozen: boolean
  banned: boolean
  /** Token units. */
  balance: string
  /** Token units held in escrow. */
  escrowed: string
}

export interface IssuanceStatus {
  issuanceId: string
  issuer: string
  assetScale: number
  globallyFrozen: boolean
  /** Token units in circulation. */
  outstanding: string
  maximum: string | undefined
  capabilities: {
    allowlist: boolean
    freeze: boolean
    clawback: boolean
    holderTransfers: boolean
    escrow: boolean
    trade: boolean
  }
}

export interface BanReport {
  holder: string
  /** Token units clawed back during the ban. */
  clawedBack: string
  transactions: TxReceipt[]
  final: HolderStatus
}

/**
 * Issuer-side compliance controls for one MPT issuance.
 *
 * On-ledger capabilities used:
 *  - Allowlist:   tfMPTRequireAuth + MPTokenAuthorize(Holder)
 *  - Freeze:      tfMPTCanLock + MPTokenIssuanceSet(tfMPTLock/tfMPTUnlock), per holder or global
 *  - Clawback:    tfMPTCanClawback + Clawback(Holder)
 *  - Ban:         durable ban list + un-approve + lock + clawback entire balance
 *
 * Escrow (tfMPTCanEscrow), DEX trading (tfMPTCanTrade) and confidential
 * balances are deliberately NOT enabled: each would let holders move value
 * somewhere a Clawback cannot reach, which would break the ban guarantee.
 *
 * Off-ledger guard: the XRP Ledger lets the issuer pay a holder even while that
 * holder (or the whole issuance) is locked, since a lock only blocks
 * holder-to-holder transfers. This module therefore refuses to issue to a
 * frozen or banned holder, or while the issuance is globally frozen.
 *
 * Instances are safe for concurrent use within one process; transactions are
 * serialized per signing account. Run only one process signing for the issuer.
 */
export class MptIssuer {
  readonly issuanceId: string
  readonly assetScale: number
  readonly #wallet: Wallet
  readonly #submitter: TransactionSubmitter
  readonly #bans: BanRegistry
  readonly #onAudit: ((event: AuditEvent) => void) | undefined

  private constructor(wallet: Wallet, state: IssuanceState, submitter: TransactionSubmitter, options: MptIssuerOptions) {
    this.issuanceId = state.issuanceId
    this.assetScale = state.assetScale
    this.#wallet = wallet
    this.#submitter = submitter
    this.#bans = options.banRegistry
    this.#onAudit = options.onAudit
  }

  get issuerAddress(): string {
    return this.#wallet.classicAddress
  }

  get client(): Client {
    return this.#submitter.client
  }

  /** Creates a new issuance with all compliance controls enabled and returns an issuer bound to it. */
  static async create(
    client: Client,
    issuerWallet: Wallet,
    params: CreateIssuanceParams,
    options: MptIssuerOptions,
  ): Promise<{ issuer: MptIssuer; tx: TxReceipt }> {
    MptIssuer.#checkNetwork(client, options)
    const { assetScale, metadata, maximumAmount, allowHolderTransfers = true } = params
    if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 255) {
      throw new InvalidInputError(`Invalid asset scale ${assetScale}`)
    }
    const metadataHex = encodeMPTokenMetadata(metadata)
    const problems = validateMPTokenMetadata(metadataHex)
    if (problems.length > 0) {
      throw new InvalidInputError(`MPTokenMetadata does not conform to XLS-89: ${problems.join('; ')}`)
    }

    let flags =
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback
    if (allowHolderTransfers) flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuerWallet.classicAddress,
      AssetScale: assetScale,
      Flags: flags,
      MPTokenMetadata: metadataHex,
      ...(maximumAmount !== undefined ? { MaximumAmount: toRawAmount(maximumAmount, assetScale).toString() } : {}),
    }
    const submitter = options.submitter ?? new TransactionSubmitter(client)
    const receipt = await submitter.submit(issuerWallet, tx)

    const fromMeta = (receipt.meta as TransactionMetadata & { mpt_issuance_id?: string }).mpt_issuance_id
    const sequence = await MptIssuer.#createdSequence(client, receipt.hash)
    const computed = computeIssuanceId(sequence, issuerWallet.classicAddress)
    if (fromMeta !== undefined && normalizeIssuanceId(fromMeta) !== computed) {
      throw new PostConditionError(`Issuance ID mismatch: metadata ${fromMeta}, computed ${computed}`)
    }
    const issuer = await MptIssuer.attach(client, issuerWallet, computed, { ...options, submitter })
    issuer.#audit({ action: 'issuance.create', txHash: receipt.hash, ledgerIndex: receipt.ledgerIndex })
    return { issuer, tx: receipt }
  }

  /**
   * Binds to an existing issuance. Fails closed if the issuance is not owned by
   * `issuerWallet` or lacks any required compliance capability.
   */
  static async attach(
    client: Client,
    issuerWallet: Wallet,
    issuanceId: string,
    options: MptIssuerOptions,
  ): Promise<MptIssuer> {
    MptIssuer.#checkNetwork(client, options)
    const id = normalizeIssuanceId(issuanceId)
    const state = await readIssuance(client, id)
    if (!state) throw new IssuanceMisconfiguredError(`Issuance ${id} not found in the validated ledger`)
    if (state.issuer !== issuerWallet.classicAddress) {
      throw new IssuanceMisconfiguredError(`Issuance ${id} is issued by ${state.issuer}, not ${issuerWallet.classicAddress}`)
    }
    const missing = [
      !state.requireAuth && 'RequireAuth',
      !state.canLock && 'CanLock',
      !state.canClawback && 'CanClawback',
    ].filter(Boolean)
    if (missing.length > 0) {
      throw new IssuanceMisconfiguredError(`Issuance ${id} lacks required capabilities: ${missing.join(', ')}`)
    }
    const unsafe = [
      state.canEscrow && 'CanEscrow',
      state.canTrade && 'CanTrade',
      state.canHoldConfidentialBalance && 'CanHoldConfidentialBalance',
    ].filter(Boolean)
    if (unsafe.length > 0) {
      throw new IssuanceMisconfiguredError(
        `Issuance ${id} enables ${unsafe.join(', ')}, which let holders move value beyond clawback`,
      )
    }
    if (state.domainId !== undefined) {
      throw new IssuanceMisconfiguredError(
        `Issuance ${id} has DomainID ${state.domainId}: domain credential holders bypass the allowlist and bans`,
      )
    }
    return new MptIssuer(issuerWallet, state, options.submitter ?? new TransactionSubmitter(client), options)
  }

  // ---------------------------------------------------------------- allowlist

  /** Approves a KYC'd holder. The holder must have opted in (MPTokenAuthorize from their account) first. */
  async approveHolder(holder: string): Promise<OpResult> {
    const address = this.#holderAddress(holder)
    await this.#assertNotBanned(address)
    const state = await this.#readHolder(address)
    if (!state.exists) throw new HolderNotOptedInError(address)
    if (state.authorized) return { changed: false, reason: 'already approved' }

    const tx = await this.#submit<MPTokenAuthorize>({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
    })
    // A ban may have been recorded while this approval was in flight; undo it.
    if (await this.#bans.isBanned(this.issuanceId, address)) {
      await this.revokeApproval(address)
      throw new ComplianceViolationError(`Holder ${address} was banned during approval; approval revoked`, 'banned', address)
    }
    this.#audit({ action: 'holder.approve', holder: address, txHash: tx.hash, ledgerIndex: tx.ledgerIndex })
    return { changed: true, tx }
  }

  /** Removes a holder's approval. They can no longer send or receive the token (balance is untouched). */
  async revokeApproval(holder: string): Promise<OpResult> {
    const address = this.#holderAddress(holder)
    const state = await this.#readHolder(address)
    if (!state.exists) return { changed: false, reason: 'holder has not opted in' }
    if (!state.authorized) return { changed: false, reason: 'not approved' }
    const tx = await this.#submit<MPTokenAuthorize>({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
    this.#audit({ action: 'holder.revoke', holder: address, txHash: tx.hash, ledgerIndex: tx.ledgerIndex })
    return { changed: true, tx }
  }

  // ------------------------------------------------------------------ issuing

  /** Issues (mints) `amount` token units to an approved, unfrozen, non-banned holder. */
  async issue(holder: string, amount: string): Promise<IssueResult> {
    const address = this.#holderAddress(holder)
    const raw = toRawAmount(amount, this.assetScale)
    await this.#assertNotBanned(address)
    const issuance = await this.#readIssuance()
    if (issuance.globallyFrozen) {
      throw new ComplianceViolationError('Token is globally frozen; issuance is suspended', 'globally-frozen', address)
    }
    const state = await this.#readHolder(address)
    if (!state.exists) throw new HolderNotOptedInError(address)
    if (!state.authorized) {
      throw new ComplianceViolationError(`Holder ${address} is not approved`, 'not-approved', address)
    }
    if (state.frozen) {
      throw new ComplianceViolationError(`Holder ${address} is frozen`, 'holder-frozen', address)
    }

    const value: MPTAmount = { mpt_issuance_id: this.issuanceId, value: raw.toString() }
    const tx = await this.#submit<Payment>({
      TransactionType: 'Payment',
      Account: this.issuerAddress,
      Destination: address,
      Amount: value,
    })
    const delivered = (tx.meta as { delivered_amount?: unknown }).delivered_amount as MPTAmount | undefined
    if (!delivered || delivered.mpt_issuance_id.toUpperCase() !== this.issuanceId || delivered.value !== value.value) {
      throw new PostConditionError(`Payment ${tx.hash} delivered ${JSON.stringify(delivered)}, expected ${value.value}`)
    }
    const deliveredUnits = fromRawAmount(parseRaw(delivered.value), this.assetScale)
    this.#audit({ action: 'holder.issue', holder: address, amount: deliveredUnits, txHash: tx.hash, ledgerIndex: tx.ledgerIndex })
    return { tx, delivered: deliveredUnits }
  }

  // ----------------------------------------------------------------- clawback

  /**
   * Claws back up to `amount` token units from a holder. Works regardless of
   * approval or freeze state. If the holder has less, the entire balance is
   * taken; the actual amount is returned.
   */
  async clawback(holder: string, amount: string): Promise<ClawbackResult> {
    const address = this.#holderAddress(holder)
    return this.#clawbackRaw(address, toRawAmount(amount, this.assetScale))
  }

  /** Claws back a holder's entire balance. No-op if the balance is zero. */
  async clawbackAll(holder: string): Promise<ClawbackResult | undefined> {
    const address = this.#holderAddress(holder)
    const state = await this.#readHolder(address)
    if (state.balanceRaw === 0n) return undefined
    // Request the maximum: the ledger caps it at the balance at execution time,
    // so tokens received between our read and execution are also taken.
    return this.#clawbackRaw(address, MAX_MPT_RAW)
  }

  async #clawbackRaw(address: string, raw: bigint): Promise<ClawbackResult> {
    const state = await this.#readHolder(address)
    if (!state.exists) throw new HolderNotOptedInError(address)
    if (state.balanceRaw === 0n) {
      throw new InvalidInputError(`Holder ${address} has no balance to claw back`)
    }
    const tx = await this.#submit<Clawback>({
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Holder: address,
      Amount: { mpt_issuance_id: this.issuanceId, value: raw.toString() },
    })
    const clawedBack = fromRawAmount(this.#balanceDelta(tx.meta, address), this.assetScale)
    this.#audit({ action: 'holder.clawback', holder: address, amount: clawedBack, txHash: tx.hash, ledgerIndex: tx.ledgerIndex })
    return { tx, clawedBack }
  }

  // ------------------------------------------------------------------- freeze

  /** Freezes one holder: they can no longer send to or receive from other holders, and this module stops issuing to them. */
  async freezeHolder(holder: string): Promise<OpResult> {
    const address = this.#holderAddress(holder)
    const state = await this.#readHolder(address)
    if (!state.exists) throw new HolderNotOptedInError(address)
    if (state.frozen) return { changed: false, reason: 'already frozen' }
    const tx = await this.#setLock(true, address)
    this.#audit({ action: 'holder.freeze', holder: address, txHash: tx.hash, ledgerIndex: tx.ledgerIndex })
    return { changed: true, tx }
  }

  /** Unfreezes one holder. Refuses for banned holders, who stay frozen permanently. */
  async unfreezeHolder(holder: string): Promise<OpResult> {
    const address = this.#holderAddress(holder)
    await this.#assertNotBanned(address)
    const state = await this.#readHolder(address)
    if (!state.exists) throw new HolderNotOptedInError(address)
    if (!state.frozen) return { changed: false, reason: 'not frozen' }
    const tx = await this.#setLock(false, address)
    this.#audit({ action: 'holder.unfreeze', holder: address, txHash: tx.hash, ledgerIndex: tx.ledgerIndex })
    return { changed: true, tx }
  }

  /** Globally freezes the token: no holder-to-holder movement, and this module stops issuing. */
  async freezeAll(): Promise<OpResult> {
    if ((await this.#readIssuance()).globallyFrozen) return { changed: false, reason: 'already globally frozen' }
    const tx = await this.#setLock(true)
    this.#audit({ action: 'issuance.freeze', txHash: tx.hash, ledgerIndex: tx.ledgerIndex })
    return { changed: true, tx }
  }

  /** Lifts a global freeze. Individually frozen holders stay frozen. */
  async unfreezeAll(): Promise<OpResult> {
    if (!(await this.#readIssuance()).globallyFrozen) return { changed: false, reason: 'not globally frozen' }
    const tx = await this.#setLock(false)
    this.#audit({ action: 'issuance.unfreeze', txHash: tx.hash, ledgerIndex: tx.ledgerIndex })
    return { changed: true, tx }
  }

  #setLock(lock: boolean, holder?: string): Promise<TxReceipt> {
    return this.#submit<MPTokenIssuanceSet>({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
      ...(holder !== undefined ? { Holder: holder } : {}),
    })
  }

  // ---------------------------------------------------------------------- ban

  /**
   * Permanently bans an address from this token:
   *  1. records the ban durably (from here on approval/issuance/unfreeze are refused),
   *  2. revokes approval (the ledger then rejects any payment to or from it),
   *  3. freezes it,
   *  4. claws back its entire balance,
   *  5. verifies the final ledger state.
   *
   * Idempotent: re-running after a partial failure completes the remaining steps.
   * Banning an address that never opted in only records the ban.
   */
  async banHolder(holder: string, reason: string): Promise<BanReport> {
    const address = this.#holderAddress(holder)
    if (!reason.trim()) throw new InvalidInputError('A ban reason is required')
    const record: BanRecord = { issuanceId: this.issuanceId, address, reason, bannedAt: new Date().toISOString() }
    await this.#bans.ban(record)

    const transactions: TxReceipt[] = []
    let clawedRaw = 0n
    const state = await this.#readHolder(address)
    if (state.exists) {
      if (state.authorized) {
        const res = await this.revokeApproval(address)
        if (res.changed) transactions.push(res.tx)
      }
      if (!state.frozen) {
        const res = await this.freezeHolder(address)
        if (res.changed) transactions.push(res.tx)
      }
      const claw = await this.clawbackAll(address)
      if (claw) {
        transactions.push(claw.tx)
        clawedRaw = toRawAmount(claw.clawedBack, this.assetScale)
      }
    }

    const final = await this.getHolder(address)
    if (final.approved || final.balance !== '0' || final.escrowed !== '0' || !final.banned) {
      throw new PostConditionError(`Ban of ${address} incomplete: ${JSON.stringify(final)}`)
    }
    // A holder may delete its (empty) MPToken, so `frozen` is only checked if the entry exists.
    if (final.optedIn && !final.frozen) {
      throw new PostConditionError(`Ban of ${address} incomplete: holder is not frozen`)
    }
    const clawedBack = fromRawAmount(clawedRaw, this.assetScale)
    this.#audit({ action: 'holder.ban', holder: address, amount: clawedBack, detail: reason })
    return { holder: address, clawedBack, transactions, final }
  }

  async isBanned(holder: string): Promise<boolean> {
    return this.#bans.isBanned(this.issuanceId, this.#holderAddress(holder))
  }

  // -------------------------------------------------------------------- reads

  async getHolder(holder: string): Promise<HolderStatus> {
    const address = this.#holderAddress(holder)
    const [state, banned] = await Promise.all([this.#readHolder(address), this.#bans.isBanned(this.issuanceId, address)])
    return {
      address,
      optedIn: state.exists,
      approved: state.authorized,
      frozen: state.frozen,
      banned,
      balance: fromRawAmount(state.balanceRaw, this.assetScale),
      escrowed: fromRawAmount(state.lockedRaw, this.assetScale),
    }
  }

  async getIssuance(): Promise<IssuanceStatus> {
    const s = await this.#readIssuance()
    return {
      issuanceId: s.issuanceId,
      issuer: s.issuer,
      assetScale: s.assetScale,
      globallyFrozen: s.globallyFrozen,
      outstanding: fromRawAmount(s.outstandingRaw, s.assetScale),
      maximum: s.maximumRaw === undefined ? undefined : fromRawAmount(s.maximumRaw, s.assetScale),
      capabilities: {
        allowlist: s.requireAuth,
        freeze: s.canLock,
        clawback: s.canClawback,
        holderTransfers: s.canTransfer,
        escrow: s.canEscrow,
        trade: s.canTrade,
      },
    }
  }

  // ------------------------------------------------------------------ helpers

  #submit<T extends Parameters<TransactionSubmitter['submit']>[1]>(tx: T): Promise<TxReceipt> {
    return this.#submitter.submit(this.#wallet, tx)
  }

  #holderAddress(holder: string): string {
    if (typeof holder !== 'string' || !isValidClassicAddress(holder)) {
      throw new InvalidInputError(`Invalid classic address "${String(holder)}"`)
    }
    if (holder === this.issuerAddress) {
      throw new InvalidInputError('The issuer cannot be a holder of its own token')
    }
    return holder
  }

  async #assertNotBanned(address: string): Promise<void> {
    if (await this.#bans.isBanned(this.issuanceId, address)) {
      throw new ComplianceViolationError(`Holder ${address} is banned`, 'banned', address)
    }
  }

  async #readIssuance(): Promise<IssuanceState> {
    const state = await readIssuance(this.client, this.issuanceId)
    if (!state) throw new IssuanceMisconfiguredError(`Issuance ${this.issuanceId} no longer exists`)
    return state
  }

  #readHolder(address: string): Promise<HolderLedgerState> {
    return readHolder(this.client, this.issuanceId, address)
  }

  /** Decrease in `holder`'s MPToken balance caused by a transaction. */
  #balanceDelta(meta: TransactionMetadata, holder: string): bigint {
    for (const node of meta.AffectedNodes) {
      const n = 'ModifiedNode' in node ? node.ModifiedNode : undefined
      if (n?.LedgerEntryType !== 'MPToken') continue
      const final = n.FinalFields as Record<string, unknown> | undefined
      if (final?.Account !== holder || String(final.MPTokenIssuanceID).toUpperCase() !== this.issuanceId) continue
      const before = parseRaw(String((n.PreviousFields as Record<string, unknown> | undefined)?.MPTAmount ?? '0'))
      const after = parseRaw(String(final.MPTAmount ?? '0'))
      return before - after
    }
    throw new PostConditionError('Could not find the holder balance change in transaction metadata')
  }

  #audit(event: Omit<AuditEvent, 'issuanceId'>): void {
    try {
      this.#onAudit?.({ issuanceId: this.issuanceId, ...event })
    } catch {
      // An audit sink failure must not mask the (already final) ledger outcome.
    }
  }

  static #checkNetwork(client: Client, options: MptIssuerOptions): void {
    if (options.expectedNetworkId !== undefined && client.networkID !== options.expectedNetworkId) {
      throw new IssuanceMisconfiguredError(
        `Connected to network ${String(client.networkID)}, expected ${options.expectedNetworkId}`,
      )
    }
  }

  static async #createdSequence(client: Client, hash: string): Promise<number> {
    const res = await client.request({ command: 'tx', transaction: hash })
    const txJson = (res.result as { tx_json?: { Sequence?: number; TicketSequence?: number } }).tx_json
    // Transactions using a Ticket have Sequence 0; the issuance ID then uses the TicketSequence.
    const seq = txJson?.Sequence || txJson?.TicketSequence
    if (!seq) {
      throw new PostConditionError(`Cannot determine sequence of transaction ${hash}`)
    }
    return seq
  }
}
