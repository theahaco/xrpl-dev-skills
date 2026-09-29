import {
  type Client,
  type MPTokenMetadata,
  type Wallet,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  validateMPTokenMetadata,
} from 'xrpl'

import { fromBaseUnits, MAX_MPT_AMOUNT, parseLedgerAmount, toBaseUnits } from './amounts.js'
import type { BanList, BanRecord } from './banList.js'
import {
  ComplianceViolationError,
  IssuanceConfigurationError,
  PostConditionError,
} from './errors.js'
import {
  getMPToken,
  getMPTokenIssuance,
  lsfMPTAuthorized,
  lsfMPTLocked,
  mptBalanceDecrease,
  type MPTokenIssuanceEntry,
  type SubmittedTransaction,
  submitTransaction,
} from './ledger.js'

/** `MPTokenIssuance` ledger-entry flags (not exported at runtime by xrpl.js). */
export const IssuanceFlags = {
  lsfMPTLocked: 0x00000001,
  lsfMPTCanLock: 0x00000002,
  lsfMPTRequireAuth: 0x00000004,
  lsfMPTCanEscrow: 0x00000008,
  lsfMPTCanTrade: 0x00000010,
  lsfMPTCanTransfer: 0x00000020,
  lsfMPTCanClawback: 0x00000040,
  lsfMPTCanHoldConfidentialBalance: 0x00000080,
} as const

/** Capabilities every issuance managed by this module must have. */
const REQUIRED_FLAGS =
  IssuanceFlags.lsfMPTCanLock | IssuanceFlags.lsfMPTRequireAuth | IssuanceFlags.lsfMPTCanClawback

/**
 * Capabilities that would let holders move balances somewhere a plain
 * `Clawback` or lock can't reach (escrows, DEX/AMM pools, encrypted balances),
 * which would undermine clawback and bans. Issuances with these are rejected.
 */
const FORBIDDEN_FLAGS =
  IssuanceFlags.lsfMPTCanEscrow |
  IssuanceFlags.lsfMPTCanTrade |
  IssuanceFlags.lsfMPTCanHoldConfidentialBalance

export type AuditAction =
  | 'ISSUANCE_CREATED'
  | 'HOLDER_AUTHORIZED'
  | 'HOLDER_AUTHORIZATION_REVOKED'
  | 'TOKENS_ISSUED'
  | 'TOKENS_CLAWED_BACK'
  | 'HOLDER_FROZEN'
  | 'HOLDER_UNFROZEN'
  | 'GLOBAL_FREEZE_ON'
  | 'GLOBAL_FREEZE_OFF'
  | 'HOLDER_BAN_RECORDED'
  | 'HOLDER_BANNED'

export interface AuditEvent {
  action: AuditAction
  issuanceId: string
  issuer: string
  holder?: string
  /** Display-unit amount, where relevant. */
  amount?: string
  txHash?: string
  ledgerIndex?: number
  reason?: string
  /** ISO-8601 timestamp. */
  at: string
}

export interface MptIssuerDeps {
  /** Durable ban list. Required: bans must survive restarts. */
  banList: BanList
  /** Receives an event after every state-changing action. Awaited, so it can write to a durable audit log. */
  onAudit?: (event: AuditEvent) => void | Promise<void>
}

export interface CreateIssuanceOptions {
  /** Decimal places of the token. Fixed at creation. Defaults to 0. */
  assetScale?: number
  /** Supply cap in display units, e.g. `"1000000"`. Defaults to the ledger maximum. */
  maximumAmount?: string
  /** XLS-89 metadata (ticker, name, issuer, ...). */
  metadata?: MPTokenMetadata
  /**
   * Whether approved holders may pay each other (Can Transfer). Defaults to
   * true. Without it, holders can only send tokens back to the issuer.
   */
  allowHolderTransfers?: boolean
  /** Fee on holder-to-holder transfers, in units of 0.001% (0–50000). Requires `allowHolderTransfers`. */
  transferFee?: number
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
  /** The holder has created an `MPToken` entry for this issuance. */
  optedIn: boolean
  /** The issuer has approved (allowlisted) the holder. */
  authorized: boolean
  /** The holder is individually frozen. See also `IssuanceState.globallyFrozen`. */
  frozen: boolean
  banned: boolean
  /** Balance in display units. */
  balance: string
  /** Balance in ledger base units. */
  balanceBaseUnits: bigint
}

export interface ActionResult {
  /** False if the ledger was already in the requested state and nothing was submitted. */
  changed: boolean
  txHash?: string
  ledgerIndex?: number
}

export interface ClawbackResult extends ActionResult {
  /** Display-unit amount actually removed from the holder. */
  clawedBack: string
}

export interface BanResult {
  address: string
  clawedBack: string
  txHashes: string[]
}

/**
 * Issuer-side compliance controls for one MPT issuance: allowlisting, issuing,
 * clawback, bans, per-holder freeze and global freeze.
 *
 * Every state-changing method checks the relevant ledger state first, refuses
 * actions that would break a compliance rule (throwing
 * `ComplianceViolationError` before anything is submitted), and verifies the
 * resulting ledger state afterwards. Freeze/unfreeze/authorize are idempotent.
 *
 * Calls on one instance are serialized, so checks and submissions don't
 * interleave. Run a single instance per issuing key.
 */
export class MptIssuer {
  #queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly client: Client,
    private readonly wallet: Wallet,
    readonly issuanceId: string,
    readonly assetScale: number,
    private readonly deps: MptIssuerDeps,
  ) {}

  get issuerAddress(): string {
    return this.wallet.address
  }

  /**
   * Creates a new issuance with allowlisting, locking and clawback enabled.
   * These capabilities can't be added later on networks without the DynamicMPT
   * amendment (including testnet today), so they're always set here.
   */
  static async createIssuance(
    client: Client,
    issuerWallet: Wallet,
    options: CreateIssuanceOptions,
    deps: MptIssuerDeps,
  ): Promise<MptIssuer> {
    const assetScale = options.assetScale ?? 0
    const allowHolderTransfers = options.allowHolderTransfers ?? true
    if (options.transferFee && !allowHolderTransfers) {
      throw new RangeError('transferFee requires allowHolderTransfers')
    }
    let metadataHex: string | undefined
    if (options.metadata) {
      const problems = validateMPTokenMetadata(encodeMPTokenMetadata(options.metadata))
      if (problems.length > 0) throw new RangeError(`Invalid MPT metadata: ${problems.join('; ')}`)
      metadataHex = encodeMPTokenMetadata(options.metadata)
    }

    const flags =
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback |
      (allowHolderTransfers ? MPTokenIssuanceCreateFlags.tfMPTCanTransfer : 0)

    const submitted = await submitTransaction(client, issuerWallet, {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuerWallet.address,
      Flags: flags,
      AssetScale: assetScale,
      ...(options.maximumAmount !== undefined && {
        MaximumAmount: toBaseUnits(options.maximumAmount, assetScale).toString(),
      }),
      ...(options.transferFee !== undefined && { TransferFee: options.transferFee }),
      ...(metadataHex !== undefined && { MPTokenMetadata: metadataHex }),
    })
    const issuanceId = (submitted.meta as { mpt_issuance_id?: string }).mpt_issuance_id
    if (!issuanceId) {
      throw new PostConditionError(`MPTokenIssuanceCreate ${submitted.hash} returned no mpt_issuance_id`)
    }

    const issuer = await MptIssuer.load(client, issuerWallet, issuanceId, deps)
    await issuer.#audit({ action: 'ISSUANCE_CREATED' }, submitted)
    return issuer
  }

  /** Attaches to an existing issuance, checking it's ours and has the required capabilities. */
  static async load(
    client: Client,
    issuerWallet: Wallet,
    issuanceId: string,
    deps: MptIssuerDeps,
  ): Promise<MptIssuer> {
    const entry = await getMPTokenIssuance(client, issuanceId)
    if (!entry) throw new IssuanceConfigurationError(`MPT issuance ${issuanceId} not found`)
    if (entry.Issuer !== issuerWallet.address) {
      throw new IssuanceConfigurationError(
        `MPT issuance ${issuanceId} is issued by ${entry.Issuer}, not ${issuerWallet.address}`,
      )
    }
    if ((entry.Flags & REQUIRED_FLAGS) !== REQUIRED_FLAGS) {
      throw new IssuanceConfigurationError(
        `MPT issuance ${issuanceId} lacks Can Lock, Require Auth or Can Clawback (flags ${entry.Flags})`,
      )
    }
    if ((entry.Flags & FORBIDDEN_FLAGS) !== 0) {
      throw new IssuanceConfigurationError(
        `MPT issuance ${issuanceId} enables escrow, trading or confidential balances (flags ${entry.Flags}), ` +
          'which would let holders move tokens out of reach of clawback',
      )
    }
    return new MptIssuer(client, issuerWallet, issuanceId, entry.AssetScale ?? 0, deps)
  }

  async getIssuanceState(): Promise<IssuanceState> {
    const entry = await this.#readIssuance()
    const has = (flag: number): boolean => (entry.Flags & flag) !== 0
    return {
      issuanceId: this.issuanceId,
      issuer: entry.Issuer,
      assetScale: this.assetScale,
      outstandingAmount: fromBaseUnits(parseLedgerAmount(entry.OutstandingAmount), this.assetScale),
      maximumAmount:
        entry.MaximumAmount === undefined
          ? undefined
          : fromBaseUnits(parseLedgerAmount(entry.MaximumAmount), this.assetScale),
      globallyFrozen: has(IssuanceFlags.lsfMPTLocked),
      capabilities: {
        canLock: has(IssuanceFlags.lsfMPTCanLock),
        requireAuth: has(IssuanceFlags.lsfMPTRequireAuth),
        canClawback: has(IssuanceFlags.lsfMPTCanClawback),
        canTransfer: has(IssuanceFlags.lsfMPTCanTransfer),
        canEscrow: has(IssuanceFlags.lsfMPTCanEscrow),
        canTrade: has(IssuanceFlags.lsfMPTCanTrade),
      },
    }
  }

  async getHolderState(address: string): Promise<HolderState> {
    this.#assertHolderAddress(address)
    const [token, ban] = await Promise.all([
      getMPToken(this.client, this.issuanceId, address),
      this.deps.banList.get(address),
    ])
    const balanceBaseUnits = parseLedgerAmount(token?.MPTAmount)
    return {
      address,
      optedIn: token !== undefined,
      authorized: token !== undefined && (token.Flags & lsfMPTAuthorized) !== 0,
      frozen: token !== undefined && (token.Flags & lsfMPTLocked) !== 0,
      banned: ban !== undefined,
      balance: fromBaseUnits(balanceBaseUnits, this.assetScale),
      balanceBaseUnits,
    }
  }

  async isBanned(address: string): Promise<boolean> {
    return (await this.deps.banList.get(address)) !== undefined
  }

  /**
   * Adds a holder to the allowlist (call after KYC). The holder must first opt
   * in by submitting their own `MPTokenAuthorize`. Banned addresses are refused.
   */
  authorizeHolder(address: string): Promise<ActionResult> {
    return this.#exclusive(async () => {
      const holder = await this.getHolderState(address)
      this.#assertNotBanned(holder)
      this.#assertOptedIn(holder)
      if (holder.authorized) return { changed: false }

      const submitted = await this.#submit({
        TransactionType: 'MPTokenAuthorize',
        Account: this.wallet.address,
        MPTokenIssuanceID: this.issuanceId,
        Holder: address,
      })
      await this.#expectHolder(address, (h) => h.authorized, 'authorized')
      await this.#audit({ action: 'HOLDER_AUTHORIZED', holder: address }, submitted)
      return this.#changed(submitted)
    })
  }

  /**
   * Removes a holder from the allowlist. Refused while they still hold tokens,
   * because an un-authorized holder's balance can't be moved by them at all;
   * claw it back first (or use `banHolder`).
   */
  revokeAuthorization(address: string, reason: string): Promise<ActionResult> {
    return this.#exclusive(async () => {
      const holder = await this.getHolderState(address)
      if (!holder.authorized) return { changed: false }
      if (holder.balanceBaseUnits > 0n) {
        throw new ComplianceViolationError(
          'HOLDER_HAS_BALANCE',
          `${address} still holds ${holder.balance}; claw it back before revoking authorization`,
        )
      }
      const submitted = await this.#unauthorize(address)
      await this.#audit({ action: 'HOLDER_AUTHORIZATION_REVOKED', holder: address, reason }, submitted)
      return this.#changed(submitted)
    })
  }

  /**
   * Sends newly issued tokens to an approved holder. Refused if the holder is
   * banned, not approved or frozen, or the token is globally frozen. The
   * ledger itself does *not* stop the issuer paying a frozen holder, so this
   * check is what enforces "frozen holders can't receive" for issuer payments.
   */
  issue(address: string, amount: string): Promise<ActionResult> {
    return this.#exclusive(async () => {
      const baseUnits = toBaseUnits(amount, this.assetScale)
      const [holder, issuance] = await Promise.all([this.getHolderState(address), this.#readIssuance()])
      this.#assertNotBanned(holder)
      this.#assertOptedIn(holder)
      if (!holder.authorized) {
        throw new ComplianceViolationError('HOLDER_NOT_AUTHORIZED', `${address} is not an approved holder`)
      }
      if (holder.frozen) {
        throw new ComplianceViolationError('HOLDER_FROZEN', `${address} is frozen`)
      }
      if ((issuance.Flags & IssuanceFlags.lsfMPTLocked) !== 0) {
        throw new ComplianceViolationError('GLOBALLY_FROZEN', 'The token is globally frozen')
      }

      const submitted = await this.#submit({
        TransactionType: 'Payment',
        Account: this.wallet.address,
        Destination: address,
        Amount: { mpt_issuance_id: this.issuanceId, value: baseUnits.toString() },
      })
      const delivered = submitted.meta.delivered_amount
      if (
        typeof delivered !== 'object' ||
        !('mpt_issuance_id' in delivered) ||
        delivered.mpt_issuance_id !== this.issuanceId ||
        BigInt(delivered.value) !== baseUnits
      ) {
        throw new PostConditionError(
          `Payment ${submitted.hash} delivered ${JSON.stringify(delivered)}, expected ${baseUnits} base units`,
        )
      }
      await this.#audit({ action: 'TOKENS_ISSUED', holder: address, amount }, submitted)
      return this.#changed(submitted)
    })
  }

  /**
   * Claws back `amount` (display units) from a holder, or their whole balance
   * with `'all'`. Works even if the holder or the whole token is frozen.
   * Refuses amounts larger than the balance rather than silently clawing less.
   */
  clawback(address: string, amount: string | 'all', reason: string): Promise<ClawbackResult> {
    return this.#exclusive(() => this.#clawback(address, amount, reason))
  }

  /** Freezes one holder: they can no longer send to or receive from other holders. */
  freezeHolder(address: string, reason: string): Promise<ActionResult> {
    return this.#exclusive(() => this.#setHolderLock(address, true, reason))
  }

  unfreezeHolder(address: string, reason: string): Promise<ActionResult> {
    return this.#exclusive(async () => {
      const holder = await this.getHolderState(address)
      // Unfreezing a banned holder would reopen holder-to-holder transfers if
      // their authorization were ever restored by mistake.
      this.#assertNotBanned(holder)
      return this.#setHolderLock(address, false, reason)
    })
  }

  /** Freezes all movement of the token between holders. */
  freezeAll(reason: string): Promise<ActionResult> {
    return this.#exclusive(() => this.#setGlobalLock(true, reason))
  }

  unfreezeAll(reason: string): Promise<ActionResult> {
    return this.#exclusive(() => this.#setGlobalLock(false, reason))
  }

  /**
   * Bans an address permanently. In order:
   *  1. records the ban durably, so this module refuses to approve or pay the
   *     address from now on, even if a later step fails;
   *  2. revokes its authorization, which stops it sending (even back to the
   *     issuer) or receiving;
   *  3. freezes it, as a second, visible on-ledger barrier;
   *  4. claws back its entire balance in one transaction.
   * Then verifies the ledger shows a zero balance, no authorization and the
   * freeze. Safe to call again to finish a ban that failed part-way.
   */
  banHolder(address: string, reason: string): Promise<BanResult> {
    return this.#exclusive(async () => {
      this.#assertHolderAddress(address)
      const existing = await this.deps.banList.get(address)
      const record: BanRecord = existing ?? {
        address,
        issuanceId: this.issuanceId,
        reason,
        bannedAt: new Date().toISOString(),
        txHashes: [],
      }
      if (!existing) {
        await this.deps.banList.put(record)
        await this.#audit({ action: 'HOLDER_BAN_RECORDED', holder: address, reason })
      }

      const recordTx = async (txHash: string | undefined): Promise<void> => {
        if (!txHash) return
        record.txHashes.push(txHash)
        await this.deps.banList.put(record)
      }

      const banReason = `ban: ${record.reason}`
      let clawedBack = fromBaseUnits(0n, this.assetScale)
      const holder = await this.getHolderState(address)
      if (holder.optedIn) {
        if (holder.authorized) {
          const submitted = await this.#unauthorize(address)
          await this.#audit({ action: 'HOLDER_AUTHORIZATION_REVOKED', holder: address, reason: banReason }, submitted)
          await recordTx(submitted.hash)
        }
        if (!holder.frozen) {
          await recordTx((await this.#setHolderLock(address, true, banReason)).txHash)
        }
        // Re-reads the balance, so anything that arrived before the
        // authorization was revoked is caught too.
        const result = await this.#clawback(address, 'all', banReason)
        clawedBack = result.clawedBack
        await recordTx(result.txHash)
        await this.#expectHolder(
          address,
          (h) => h.balanceBaseUnits === 0n && !h.authorized && h.frozen,
          'zero balance, un-authorized and frozen',
        )
      }
      // A holder that never opted in holds nothing and can't be paid without
      // authorization, which the ban list now blocks.

      await this.#audit({ action: 'HOLDER_BANNED', holder: address, amount: clawedBack, reason: record.reason })
      return { address, clawedBack, txHashes: [...record.txHashes] }
    })
  }

  // --- internals -----------------------------------------------------------

  async #clawback(address: string, amount: string | 'all', reason: string): Promise<ClawbackResult> {
    const holder = await this.getHolderState(address)
    const zero = fromBaseUnits(0n, this.assetScale)
    let value: bigint
    if (amount === 'all') {
      if (holder.balanceBaseUnits === 0n) return { changed: false, clawedBack: zero }
      // Requesting the ledger maximum claws back whatever the balance is at
      // execution time, so nothing received in the meantime is missed.
      value = MAX_MPT_AMOUNT
    } else {
      value = toBaseUnits(amount, this.assetScale)
      if (value > holder.balanceBaseUnits) {
        throw new ComplianceViolationError(
          'INVALID_AMOUNT',
          `Cannot claw back ${amount} from ${address}: balance is ${holder.balance}`,
        )
      }
    }

    const submitted = await this.#submit({
      TransactionType: 'Clawback',
      Account: this.wallet.address,
      Holder: address,
      Amount: { mpt_issuance_id: this.issuanceId, value: value.toString() },
    })
    const removed = mptBalanceDecrease(submitted.meta, this.issuanceId, address)
    if (removed <= 0n || (amount !== 'all' && removed !== value)) {
      throw new PostConditionError(
        `Clawback ${submitted.hash} removed ${removed} base units, expected ${amount === 'all' ? 'the full balance' : value}`,
      )
    }
    const clawedBack = fromBaseUnits(removed, this.assetScale)
    await this.#audit({ action: 'TOKENS_CLAWED_BACK', holder: address, amount: clawedBack, reason }, submitted)
    return { ...this.#changed(submitted), clawedBack }
  }

  async #setHolderLock(address: string, lock: boolean, reason: string): Promise<ActionResult> {
    const holder = await this.getHolderState(address)
    this.#assertOptedIn(holder)
    if (holder.frozen === lock) return { changed: false }
    const submitted = await this.#submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.wallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    await this.#expectHolder(address, (h) => h.frozen === lock, lock ? 'frozen' : 'not frozen')
    await this.#audit({ action: lock ? 'HOLDER_FROZEN' : 'HOLDER_UNFROZEN', holder: address, reason }, submitted)
    return this.#changed(submitted)
  }

  async #setGlobalLock(lock: boolean, reason: string): Promise<ActionResult> {
    const isLocked = (entry: MPTokenIssuanceEntry): boolean => (entry.Flags & IssuanceFlags.lsfMPTLocked) !== 0
    if (isLocked(await this.#readIssuance()) === lock) return { changed: false }
    const submitted = await this.#submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.wallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    })
    if (isLocked(await this.#readIssuance()) !== lock) {
      throw new PostConditionError(`Global ${lock ? 'freeze' : 'unfreeze'} ${submitted.hash} did not take effect`)
    }
    await this.#audit({ action: lock ? 'GLOBAL_FREEZE_ON' : 'GLOBAL_FREEZE_OFF', reason }, submitted)
    return this.#changed(submitted)
  }

  async #unauthorize(address: string): Promise<SubmittedTransaction> {
    const submitted = await this.#submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.wallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
    await this.#expectHolder(address, (h) => !h.authorized, 'un-authorized')
    return submitted
  }

  #submit(transaction: Parameters<typeof submitTransaction>[2]): Promise<SubmittedTransaction> {
    return submitTransaction(this.client, this.wallet, transaction)
  }

  async #readIssuance(): Promise<MPTokenIssuanceEntry> {
    const entry = await getMPTokenIssuance(this.client, this.issuanceId)
    if (!entry) throw new IssuanceConfigurationError(`MPT issuance ${this.issuanceId} no longer exists`)
    return entry
  }

  async #expectHolder(address: string, predicate: (h: HolderState) => boolean, description: string): Promise<void> {
    const holder = await this.getHolderState(address)
    if (!predicate(holder)) {
      throw new PostConditionError(`Expected ${address} to be ${description}; ledger shows ${describe(holder)}`)
    }
  }

  #assertHolderAddress(address: string): void {
    if (!isValidClassicAddress(address)) {
      throw new ComplianceViolationError('INVALID_ADDRESS', `"${address}" is not a valid classic address`)
    }
    if (address === this.wallet.address) {
      throw new ComplianceViolationError('ISSUER_AS_HOLDER', 'The issuer cannot be a holder of its own token')
    }
  }

  #assertNotBanned(holder: HolderState): void {
    if (holder.banned) throw new ComplianceViolationError('HOLDER_BANNED', `${holder.address} is banned`)
  }

  #assertOptedIn(holder: HolderState): void {
    if (!holder.optedIn) {
      throw new ComplianceViolationError(
        'HOLDER_NOT_OPTED_IN',
        `${holder.address} has not opted in to this token (no MPToken entry)`,
      )
    }
  }

  #changed(submitted: SubmittedTransaction): ActionResult {
    return { changed: true, txHash: submitted.hash, ledgerIndex: submitted.ledgerIndex }
  }

  async #audit(
    event: Omit<AuditEvent, 'issuanceId' | 'issuer' | 'at'>,
    submitted?: SubmittedTransaction,
  ): Promise<void> {
    await this.deps.onAudit?.({
      ...event,
      issuanceId: this.issuanceId,
      issuer: this.wallet.address,
      ...(submitted && { txHash: submitted.hash, ledgerIndex: submitted.ledgerIndex }),
      at: new Date().toISOString(),
    })
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn)
    this.#queue = result.catch(() => undefined)
    return result
  }
}

function describe(holder: HolderState): string {
  return `balance=${holder.balance} optedIn=${holder.optedIn} authorized=${holder.authorized} frozen=${holder.frozen}`
}
