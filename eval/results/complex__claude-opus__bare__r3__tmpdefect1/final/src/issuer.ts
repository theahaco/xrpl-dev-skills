import {
  type Client,
  type LedgerEntryRequest,
  type MPTokenMetadata,
  type Wallet,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  RippledError,
  encodeMPTokenMetadata,
  isValidClassicAddress,
} from 'xrpl'

import type { BanRecord, BanRegistry } from './banRegistry.js'
import { InvalidArgumentError, LedgerStateError, PolicyViolationError } from './errors.js'
import { type SubmitOptions, submitAndConfirm } from './submit.js'

/** Flags on the MPTokenIssuance ledger entry. */
export const IssuanceFlags = {
  locked: 0x01,
  canLock: 0x02,
  requireAuth: 0x04,
  canEscrow: 0x08,
  canTrade: 0x10,
  canTransfer: 0x20,
  canClawback: 0x40,
  canHoldConfidentialBalance: 0x80,
} as const

/** Flags on a holder's MPToken ledger entry. */
export const HolderFlags = {
  locked: 0x01,
  authorized: 0x02,
} as const

/** Largest amount an MPT can represent (2^63 - 1 base units). */
export const MAX_MPT_AMOUNT = 0x7fff_ffff_ffff_ffffn

/**
 * Controls every compliant issuance must have: holders must be approved
 * (allowlist), the issuer must be able to freeze (per holder and globally)
 * and claw back.
 */
const REQUIRED_FLAGS = IssuanceFlags.requireAuth | IssuanceFlags.canLock | IssuanceFlags.canClawback

/**
 * Capabilities that would let tokens move out of the issuer's reach:
 * escrowed balances are not covered by clawback, DEX offers can move tokens
 * outside the per-holder controls, and confidential balances hide amounts
 * from the issuer. Issuances with any of these enabled are rejected.
 */
const FORBIDDEN_FLAGS =
  IssuanceFlags.canEscrow | IssuanceFlags.canTrade | IssuanceFlags.canHoldConfidentialBalance

/** An amount in the token's smallest on-ledger unit (see `assetScale`). */
export type Amount = bigint | string

/**
 * Outcome of a mutating call. `changed: false` means the ledger was already
 * in the requested state and nothing was submitted.
 */
export type Receipt = { changed: true; hash: string; ledgerIndex: number } | { changed: false }

export interface HolderState {
  address: string
  /** False if the holder has never opted in (or has deleted their MPToken entry). */
  optedIn: boolean
  authorized: boolean
  frozen: boolean
  balance: bigint
  /** Amount held in escrow. Always 0 while the issuance forbids escrow. */
  lockedAmount: bigint
  banned: boolean
}

export interface IssuanceState {
  issuanceId: string
  issuer: string
  assetScale: number
  maximumAmount: bigint | undefined
  outstandingAmount: bigint
  globallyFrozen: boolean
  flags: {
    requireAuth: boolean
    canLock: boolean
    canClawback: boolean
    canTransfer: boolean
    canEscrow: boolean
    canTrade: boolean
    canHoldConfidentialBalance: boolean
  }
  metadata: string | undefined
}

export interface BanResult {
  address: string
  clawedBack: bigint
  receipts: Receipt[]
}

export interface AuditLogger {
  info(event: string, fields: Record<string, unknown>): void
  warn(event: string, fields: Record<string, unknown>): void
}

export interface CreateIssuanceOptions {
  /** Number of decimal places. A balance of 12345 with assetScale 2 is 123.45 tokens. */
  assetScale: number
  /** Optional hard supply cap in base units. */
  maximumAmount?: Amount
  /** Whether approved holders can transfer to each other (true) or only to/from the issuer. */
  canTransfer: boolean
  /** XLS-89 metadata. */
  metadata?: MPTokenMetadata
}

export interface MptIssuerOptions {
  client: Client
  issuerWallet: Wallet
  issuanceId: string
  banRegistry: BanRegistry
  logger?: AuditLogger
  submitOptions?: SubmitOptions
}

const noopLogger: AuditLogger = { info: () => {}, warn: () => {} }

/**
 * Issuer-side operations for a compliance-controlled MPT issuance.
 *
 * Every mutating method resolves only once its transaction is in a validated
 * ledger with tesSUCCESS, and throws otherwise (see errors.ts). The ledger is
 * authoritative; pre-flight checks here exist to give clear errors and to
 * enforce policy the ledger can't (bans).
 */
export class MptIssuer {
  readonly client: Client
  readonly issuerWallet: Wallet
  readonly issuanceId: string
  private readonly bans: BanRegistry
  private readonly log: AuditLogger
  private readonly submitOptions: SubmitOptions

  private constructor(opts: MptIssuerOptions) {
    this.client = opts.client
    this.issuerWallet = opts.issuerWallet
    this.issuanceId = opts.issuanceId
    this.bans = opts.banRegistry
    this.log = opts.logger ?? noopLogger
    this.submitOptions = opts.submitOptions ?? {}
  }

  get issuer(): string {
    return this.issuerWallet.classicAddress
  }

  /**
   * Create a new issuance with the allowlist, freeze and clawback controls
   * enabled. These flags can't be changed after creation.
   * Returns the MPTokenIssuanceID.
   */
  static async createIssuance(
    client: Client,
    issuerWallet: Wallet,
    opts: CreateIssuanceOptions,
    submitOptions: SubmitOptions = {},
  ): Promise<{ issuanceId: string; receipt: Receipt }> {
    if (!Number.isInteger(opts.assetScale) || opts.assetScale < 0 || opts.assetScale > 255) {
      throw new InvalidArgumentError('assetScale must be an integer in [0, 255]')
    }
    let flags =
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback
    if (opts.canTransfer) flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer

    const res = await submitAndConfirm(
      client,
      issuerWallet,
      {
        TransactionType: 'MPTokenIssuanceCreate',
        Account: issuerWallet.classicAddress,
        Flags: flags,
        AssetScale: opts.assetScale,
        ...(opts.maximumAmount !== undefined && { MaximumAmount: parseAmount(opts.maximumAmount).toString() }),
        ...(opts.metadata !== undefined && { MPTokenMetadata: encodeMPTokenMetadata(opts.metadata) }),
      },
      submitOptions,
    )
    const issuanceId = (res.meta as { mpt_issuance_id?: string }).mpt_issuance_id
    if (issuanceId === undefined) {
      throw new LedgerStateError(`MPTokenIssuanceCreate ${res.hash} succeeded but metadata has no mpt_issuance_id`)
    }
    return { issuanceId, receipt: { changed: true, hash: res.hash, ledgerIndex: res.ledgerIndex } }
  }

  /**
   * Attach to an existing issuance. Fails if the wallet is not the issuer, or
   * if the issuance is missing a required control or has a forbidden one.
   */
  static async open(opts: MptIssuerOptions): Promise<MptIssuer> {
    if (!/^[0-9A-F]{48}$/i.test(opts.issuanceId)) {
      throw new InvalidArgumentError(`Invalid MPTokenIssuanceID: ${opts.issuanceId}`)
    }
    const issuer = new MptIssuer({ ...opts, issuanceId: opts.issuanceId.toUpperCase() })
    const state = await issuer.getIssuanceState()
    if (state.issuer !== issuer.issuer) {
      throw new PolicyViolationError(`Issuance ${state.issuanceId} belongs to ${state.issuer}, not ${issuer.issuer}`)
    }
    const raw = await issuer.issuanceFlags()
    const missing = REQUIRED_FLAGS & ~raw
    const forbidden = FORBIDDEN_FLAGS & raw
    if (missing !== 0 || forbidden !== 0) {
      throw new PolicyViolationError(
        `Issuance ${state.issuanceId} does not meet compliance policy ` +
          `(missing flags 0x${missing.toString(16)}, forbidden flags 0x${forbidden.toString(16)})`,
      )
    }
    return issuer
  }

  // ---------------------------------------------------------------- allowlist

  /**
   * Approve a holder (after KYC). The holder must already have opted in by
   * submitting their own MPTokenAuthorize. Refuses banned addresses.
   */
  async authorizeHolder(holder: string): Promise<Receipt> {
    this.assertHolderAddress(holder)
    await this.assertNotBanned(holder, 'authorize')
    const state = await this.getHolderState(holder)
    if (!state.optedIn) {
      throw new LedgerStateError(`${holder} has not opted in to ${this.issuanceId}; they must submit MPTokenAuthorize first`)
    }
    if (state.authorized) {
      this.log.info('authorize.noop', { holder })
      return this.noopReceipt()
    }
    return this.submit('authorize', { holder }, {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuer,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
    })
  }

  /**
   * Remove a holder from the allowlist. They can no longer send or receive,
   * but keep any balance they have. Use {@link ban} to also remove the balance.
   */
  async revokeHolder(holder: string): Promise<Receipt> {
    this.assertHolderAddress(holder)
    const state = await this.getHolderState(holder)
    if (!state.authorized) {
      this.log.info('revoke.noop', { holder })
      return this.noopReceipt()
    }
    return this.submit('revoke', { holder }, {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuer,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
  }

  // ------------------------------------------------------------ issue/clawback

  /**
   * Send newly issued tokens to an approved holder.
   *
   * Refuses frozen holders and refuses while the issuance is globally frozen.
   * The ledger's MPT lock only blocks holder-to-holder payments, and
   * payments to/from the issuer still go through. So this check is what
   * stops a frozen holder receiving from the issuer.
   */
  async issue(holder: string, amount: Amount): Promise<Receipt> {
    this.assertHolderAddress(holder)
    const value = parseAmount(amount)
    await this.assertNotBanned(holder, 'issue to')
    const [state, issuance] = await Promise.all([this.getHolderState(holder), this.getIssuanceState()])
    if (!state.authorized) throw new LedgerStateError(`${holder} is not an approved holder`)
    if (state.frozen) throw new PolicyViolationError(`Refusing to issue to ${holder}: holder is frozen`)
    if (issuance.globallyFrozen) throw new PolicyViolationError('Refusing to issue: the token is globally frozen')
    return this.submit('issue', { holder, amount: value.toString() }, {
      TransactionType: 'Payment',
      Account: this.issuer,
      Destination: holder,
      Amount: { mpt_issuance_id: this.issuanceId, value: value.toString() },
    })
  }

  /**
   * Claw back exactly `amount` from a holder. Fails (without submitting) if
   * the holder has less than that, rather than silently clawing back less.
   */
  async clawback(holder: string, amount: Amount): Promise<Receipt> {
    this.assertHolderAddress(holder)
    const value = parseAmount(amount)
    const state = await this.getHolderState(holder)
    if (state.balance < value) {
      throw new LedgerStateError(`${holder} holds ${state.balance}, cannot claw back ${value}`)
    }
    return this.submitClawback(holder, value)
  }

  /** Claw back a holder's entire balance. Returns the amount clawed back. */
  async clawbackAll(holder: string): Promise<{ amount: bigint; receipts: Receipt[] }> {
    this.assertHolderAddress(holder)
    const receipts: Receipt[] = []
    let total = 0n
    // Loop because the balance could change between the read and the
    // clawback (e.g. an incoming payment in the same ledger).
    for (let attempt = 0; attempt < 5; attempt++) {
      const { balance } = await this.getHolderState(holder)
      if (balance === 0n) return { amount: total, receipts }
      receipts.push(await this.submitClawback(holder, balance))
      total += balance
    }
    throw new LedgerStateError(`Balance of ${holder} still non-zero after repeated clawbacks`)
  }

  // ------------------------------------------------------------------- freezes

  /**
   * Freeze one holder. The ledger then rejects payments between them and any
   * other holder, and this module refuses to issue to them.
   *
   * The ledger still accepts a frozen holder sending tokens to the issuer
   * (redemption), so redemption processing must check
   * {@link getHolderState}.frozen before paying out.
   */
  async freezeHolder(holder: string): Promise<Receipt> {
    this.assertHolderAddress(holder)
    const state = await this.getHolderState(holder)
    if (!state.optedIn) throw new LedgerStateError(`${holder} has no MPToken entry to freeze`)
    if (state.frozen) {
      this.log.info('freezeHolder.noop', { holder })
      return this.noopReceipt()
    }
    return this.setLock('freezeHolder', true, holder)
  }

  /** Lift a per-holder freeze. Refuses banned holders. */
  async unfreezeHolder(holder: string): Promise<Receipt> {
    this.assertHolderAddress(holder)
    await this.assertNotBanned(holder, 'unfreeze')
    const state = await this.getHolderState(holder)
    if (!state.frozen) {
      this.log.info('unfreezeHolder.noop', { holder })
      return this.noopReceipt()
    }
    return this.setLock('unfreezeHolder', false, holder)
  }

  /**
   * Freeze all movement of the token: the ledger rejects all holder-to-holder
   * payments and this module refuses to issue. The same caveat as
   * {@link freezeHolder} applies: holder-to-issuer payments still go through.
   */
  async freezeAll(): Promise<Receipt> {
    if ((await this.getIssuanceState()).globallyFrozen) {
      this.log.info('freezeAll.noop', {})
      return this.noopReceipt()
    }
    return this.setLock('freezeAll', true)
  }

  /** Lift the global freeze. Per-holder freezes stay in place. */
  async unfreezeAll(): Promise<Receipt> {
    if (!(await this.getIssuanceState()).globallyFrozen) {
      this.log.info('unfreezeAll.noop', {})
      return this.noopReceipt()
    }
    return this.setLock('unfreezeAll', false)
  }

  // ---------------------------------------------------------------------- bans

  /**
   * Ban an address: it ends up holding none of the token and can never
   * receive it again.
   *
   * 1. Record the ban durably. From here on, this module refuses to
   *    authorize, issue to, or unfreeze the address.
   * 2. Freeze the holder, so they can't move tokens out while we act.
   * 3. Revoke authorization. Because the issuance requires authorization,
   *    the ledger then rejects any payment to them. This holds even if they
   *    delete and recreate their MPToken entry, because a new entry starts
   *    unauthorized.
   * 4. Claw back the entire balance.
   *
   * Idempotent and safe to retry: if a step fails, calling ban() again
   * resumes from wherever the ledger is.
   */
  async ban(holder: string, reason: string): Promise<BanResult> {
    this.assertHolderAddress(holder)
    if (reason.trim() === '') throw new InvalidArgumentError('A ban reason is required')
    const isNew = await this.bans.add({ address: holder, reason, bannedAt: new Date().toISOString() })
    if (isNew) this.log.warn('ban.recorded', { holder, reason })
    else this.log.info('ban.alreadyRecorded', { holder })
    return this.enforceBan(holder)
  }

  /** Re-apply the on-ledger side of a recorded ban. Use to reconcile periodically. */
  async enforceBan(holder: string): Promise<BanResult> {
    if (!(await this.bans.isBanned(holder))) throw new PolicyViolationError(`${holder} is not banned`)
    const receipts: Receipt[] = []
    let state = await this.getHolderState(holder)
    if (!state.optedIn) {
      // No MPToken entry means no balance, and any entry they create later
      // starts unauthorized.
      this.log.info('ban.enforced', { holder, clawedBack: '0' })
      return { address: holder, clawedBack: 0n, receipts }
    }
    if (state.lockedAmount > 0n) {
      throw new LedgerStateError(`${holder} has ${state.lockedAmount} in escrow; this needs manual review`)
    }
    if (!state.frozen) receipts.push(await this.setLock('ban.freeze', true, holder))
    if (state.authorized) {
      const r = await this.revokeHolder(holder)
      if (r.changed) receipts.push(r)
    }
    const clawed = await this.clawbackAll(holder)
    receipts.push(...clawed.receipts)

    state = await this.getHolderState(holder)
    if (state.balance !== 0n || state.authorized) {
      throw new LedgerStateError(
        `Ban of ${holder} did not take effect (balance ${state.balance}, authorized ${state.authorized})`,
      )
    }
    const log = receipts.length > 0 ? this.log.warn : this.log.info
    log('ban.enforced', { holder, clawedBack: clawed.amount.toString() })
    return { address: holder, clawedBack: clawed.amount, receipts }
  }

  /** Re-apply every recorded ban. Returns only the bans that needed changes. */
  async enforceAllBans(): Promise<BanResult[]> {
    const results: BanResult[] = []
    for (const { address } of await this.bans.list()) {
      const r = await this.enforceBan(address)
      if (r.receipts.length > 0) results.push(r)
    }
    return results
  }

  isBanned(address: string): Promise<boolean> {
    return this.bans.isBanned(address)
  }

  getBan(address: string): Promise<BanRecord | undefined> {
    return this.bans.get(address)
  }

  // --------------------------------------------------------------------- reads

  async getHolderState(holder: string): Promise<HolderState> {
    this.assertHolderAddress(holder)
    const banned = await this.bans.isBanned(holder)
    const node = await this.ledgerEntry<{ Flags: number; MPTAmount?: string; LockedAmount?: string }>({
      mptoken: { mpt_issuance_id: this.issuanceId, account: holder },
    })
    if (node === undefined) {
      return { address: holder, optedIn: false, authorized: false, frozen: false, balance: 0n, lockedAmount: 0n, banned }
    }
    return {
      address: holder,
      optedIn: true,
      authorized: (node.Flags & HolderFlags.authorized) !== 0,
      frozen: (node.Flags & HolderFlags.locked) !== 0,
      balance: BigInt(node.MPTAmount ?? '0'),
      lockedAmount: BigInt(node.LockedAmount ?? '0'),
      banned,
    }
  }

  async getIssuanceState(): Promise<IssuanceState> {
    const node = await this.issuanceNode()
    const has = (f: number) => (node.Flags & f) !== 0
    return {
      issuanceId: this.issuanceId,
      issuer: node.Issuer,
      assetScale: node.AssetScale ?? 0,
      maximumAmount: node.MaximumAmount === undefined ? undefined : BigInt(node.MaximumAmount),
      outstandingAmount: BigInt(node.OutstandingAmount),
      globallyFrozen: has(IssuanceFlags.locked),
      flags: {
        requireAuth: has(IssuanceFlags.requireAuth),
        canLock: has(IssuanceFlags.canLock),
        canClawback: has(IssuanceFlags.canClawback),
        canTransfer: has(IssuanceFlags.canTransfer),
        canEscrow: has(IssuanceFlags.canEscrow),
        canTrade: has(IssuanceFlags.canTrade),
        canHoldConfidentialBalance: has(IssuanceFlags.canHoldConfidentialBalance),
      },
      metadata: node.MPTokenMetadata,
    }
  }

  // ------------------------------------------------------------------ internal

  private async issuanceFlags(): Promise<number> {
    return (await this.issuanceNode()).Flags
  }

  private async issuanceNode() {
    const node = await this.ledgerEntry<{
      Flags: number
      Issuer: string
      AssetScale?: number
      MaximumAmount?: string
      OutstandingAmount: string
      MPTokenMetadata?: string
    }>({ mpt_issuance: this.issuanceId })
    if (node === undefined) throw new LedgerStateError(`Issuance ${this.issuanceId} not found`)
    return node
  }

  private async ledgerEntry<T>(selector: Record<string, unknown>): Promise<T | undefined> {
    if (!this.client.isConnected()) await this.client.connect()
    try {
      const res = await this.client.request({
        command: 'ledger_entry',
        ledger_index: 'validated',
        ...selector,
      } as LedgerEntryRequest)
      return res.result.node as T | undefined
    } catch (err) {
      if (err instanceof RippledError && (err.data as { error?: string } | undefined)?.error === 'entryNotFound') {
        return undefined
      }
      throw err
    }
  }

  private setLock(action: string, lock: boolean, holder?: string): Promise<Receipt> {
    return this.submit(action, holder === undefined ? {} : { holder }, {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuer,
      MPTokenIssuanceID: this.issuanceId,
      ...(holder !== undefined && { Holder: holder }),
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
  }

  private submitClawback(holder: string, value: bigint): Promise<Receipt> {
    return this.submit('clawback', { holder, amount: value.toString() }, {
      TransactionType: 'Clawback',
      Account: this.issuer,
      Amount: { mpt_issuance_id: this.issuanceId, value: value.toString() },
      Holder: holder,
    })
  }

  private async submit(
    action: string,
    fields: Record<string, unknown>,
    tx: Parameters<typeof submitAndConfirm>[2],
  ): Promise<Receipt> {
    try {
      const res = await submitAndConfirm(this.client, this.issuerWallet, tx, this.submitOptions)
      this.log.info(action, { ...fields, hash: res.hash, ledgerIndex: res.ledgerIndex })
      return { changed: true, hash: res.hash, ledgerIndex: res.ledgerIndex }
    } catch (err) {
      this.log.warn(`${action}.failed`, { ...fields, error: String(err) })
      throw err
    }
  }

  private noopReceipt(): Receipt {
    return { changed: false }
  }

  private assertHolderAddress(address: string): void {
    if (!isValidClassicAddress(address)) throw new InvalidArgumentError(`Invalid classic address: ${address}`)
    if (address === this.issuer) throw new InvalidArgumentError('The issuer cannot be a holder')
  }

  private async assertNotBanned(address: string, action: string): Promise<void> {
    const ban = await this.bans.get(address)
    if (ban) throw new PolicyViolationError(`Refusing to ${action} ${address}: banned at ${ban.bannedAt} (${ban.reason})`)
  }
}

/** Parse a positive integer amount in base units. */
export function parseAmount(amount: Amount): bigint {
  let value: bigint
  if (typeof amount === 'bigint') {
    value = amount
  } else if (/^[0-9]+$/.test(amount)) {
    value = BigInt(amount)
  } else {
    throw new InvalidArgumentError(`Amount must be a non-negative integer string in base units, got "${amount}"`)
  }
  if (value <= 0n || value > MAX_MPT_AMOUNT) {
    throw new InvalidArgumentError(`Amount out of range: ${value}`)
  }
  return value
}
