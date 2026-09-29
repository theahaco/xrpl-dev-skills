import {
  type Client,
  type MPTAmount,
  type MPTokenMetadata,
  type SubmittableTransaction,
  type TransactionMetadata,
  type Wallet,
  LedgerEntry,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  encodeMPTokenMetadata,
  isValidClassicAddress,
} from 'xrpl'

import { MAX_MPT_AMOUNT, fromBaseUnits, parseLedgerAmount, toBaseUnits } from './amount.js'
import type { BanRecord, BanRegistry } from './banRegistry.js'
import {
  InvalidInputError,
  IssuanceConfigurationError,
  PolicyViolationError,
  PostConditionError,
} from './errors.js'
import {
  type MPTokenEntry,
  type ValidatedTx,
  MPTokenFlags,
  getIssuanceEntry,
  getMPTokenEntry,
  submitOrThrow,
} from './ledger.js'

type MPTokenIssuance = LedgerEntry.MPTokenIssuance
const { MPTokenIssuanceFlags } = LedgerEntry

/** Issuance capabilities the compliance controls depend on. */
export const REQUIRED_ISSUANCE_FLAGS =
  MPTokenIssuanceFlags.lsfMPTRequireAuth | MPTokenIssuanceFlags.lsfMPTCanLock | MPTokenIssuanceFlags.lsfMPTCanClawback

/**
 * Capabilities this module refuses to work with, because each one lets value sit
 * where the standard Clawback transaction can't reach it or where the allowlist
 * doesn't apply. With any of them, a ban could no longer guarantee a zero balance.
 *  - CanEscrow: escrowed balances (LockedAmount) can't be clawed back.
 *  - CanHoldConfidentialBalance: encrypted balances need ConfidentialMPTClawback.
 *  - CanTrade: DEX/AMM positions live in offers or pseudo-accounts.
 */
export const FORBIDDEN_ISSUANCE_FLAGS =
  MPTokenIssuanceFlags.lsfMPTCanEscrow |
  MPTokenIssuanceFlags.lsfMPTCanTrade |
  MPTokenIssuanceFlags.lsfMPTCanHoldConfidentialBalance

export interface CreateIssuanceOptions {
  /** Decimal places of the token. For example, 2 means 1 token = 100 base units. */
  assetScale: number
  /** Supply cap in token units. Defaults to the ledger maximum. */
  maximumAmount?: string
  /** XLS-89 metadata, encoded on-ledger (max 1024 bytes). */
  metadata?: MPTokenMetadata
  /**
   * Whether approved holders may pay each other (tfMPTCanTransfer). If false, holders
   * can only transact with the issuer. Defaults to true. The DynamicMPT amendment isn't
   * enabled on testnet or mainnet, so this can't be changed after creation.
   */
  allowHolderTransfers?: boolean
  /** Transfer fee in units of 0.001% (0 to 50000). Needs allowHolderTransfers. */
  transferFee?: number
}

export interface MptIssuerOptions {
  client: Client
  /** The issuer's signing wallet. */
  wallet: Wallet
  banRegistry: BanRegistry
  /** Refuse to sign unless connected to this network (1 = testnet, 0 = mainnet). */
  expectedNetworkId: number
  /** Called after every ledger-changing compliance action; wire this to your audit log. */
  onAudit?: (event: AuditEvent) => void
}

export interface AuditEvent {
  action: string
  issuanceId: string
  holder?: string
  amount?: string
  txHash?: string
  ledgerIndex?: number
  detail?: string
}

export type Outcome =
  | { status: 'submitted'; hash: string; ledgerIndex: number }
  | { status: 'noop'; reason: string }

export interface HolderStatus {
  address: string
  /** Whether the holder has an MPToken entry (has opted in to hold the token). */
  optedIn: boolean
  approved: boolean
  frozen: boolean
  banned: boolean
  /** Balance in token units. */
  balance: string
  /** Balance in integer base units, as stored on-ledger. */
  balanceBaseUnits: bigint
}

export interface IssuanceStatus {
  issuanceId: string
  issuer: string
  assetScale: number
  globallyFrozen: boolean
  outstanding: string
  maximum: string
  flags: number
}

export interface BanReport {
  address: string
  record: BanRecord
  steps: Array<{ step: 'freeze' | 'revoke-approval' | 'clawback'; outcome: Outcome; amount?: string }>
  finalStatus: HolderStatus
}

/**
 * Issuer-side compliance controls for one MPT issuance.
 *
 * All ledger-changing methods are serialized per instance, so concurrent calls from
 * your backend can't collide on account Sequence numbers. Run at most one instance
 * per issuer account; for more, use Tickets or an external lock.
 */
export class MptIssuer {
  readonly issuanceId: string
  readonly assetScale: number
  readonly #client: Client
  readonly #wallet: Wallet
  readonly #bans: BanRegistry
  readonly #networkId: number
  readonly #onAudit: ((event: AuditEvent) => void) | undefined
  #queue: Promise<unknown> = Promise.resolve()

  private constructor(options: MptIssuerOptions, issuance: MPTokenIssuance, issuanceId: string) {
    this.#client = options.client
    this.#wallet = options.wallet
    this.#bans = options.banRegistry
    this.#networkId = options.expectedNetworkId
    this.#onAudit = options.onAudit
    this.issuanceId = issuanceId
    this.assetScale = issuance.AssetScale ?? 0
  }

  /** Creates a new issuance with every compliance control enabled and returns an issuer for it. */
  static async createIssuance(options: MptIssuerOptions, params: CreateIssuanceOptions): Promise<MptIssuer> {
    const allowTransfers = params.allowHolderTransfers ?? true
    if (params.transferFee !== undefined) {
      if (!Number.isInteger(params.transferFee) || params.transferFee < 0 || params.transferFee > 50_000) {
        throw new InvalidInputError('transferFee must be an integer between 0 and 50000')
      }
      if (params.transferFee > 0 && !allowTransfers) {
        throw new InvalidInputError('A transfer fee requires allowHolderTransfers')
      }
    }
    const maximum = params.maximumAmount === undefined ? undefined : toBaseUnits(params.maximumAmount, params.assetScale)
    if (maximum === 0n) throw new InvalidInputError('maximumAmount must be positive')

    let flags =
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback
    if (allowTransfers) flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer

    const tx: SubmittableTransaction = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: options.wallet.classicAddress,
      AssetScale: params.assetScale,
      Flags: flags,
      ...(maximum !== undefined && { MaximumAmount: maximum.toString() }),
      ...(params.transferFee && { TransferFee: params.transferFee }),
      ...(params.metadata && { MPTokenMetadata: encodeMPTokenMetadata(params.metadata) }),
    }
    const result = await submitOrThrow(options.client, options.wallet, tx, options.expectedNetworkId)
    const issuanceId = (result.meta as TransactionMetadata & { mpt_issuance_id?: string }).mpt_issuance_id
    if (!issuanceId) throw new PostConditionError(`No mpt_issuance_id in metadata of ${result.hash}`)

    const issuer = await MptIssuer.open(options, issuanceId)
    issuer.#audit({ action: 'create-issuance', txHash: result.hash, ledgerIndex: result.ledgerIndex })
    return issuer
  }

  /** Attaches to an existing issuance after checking that the controls are available. */
  static async open(options: MptIssuerOptions, issuanceId: string): Promise<MptIssuer> {
    if (!/^[0-9A-F]{48}$/i.test(issuanceId)) throw new InvalidInputError(`Invalid MPT issuance ID ${issuanceId}`)
    const issuance = await getIssuanceEntry(options.client, issuanceId)
    if (!issuance) throw new IssuanceConfigurationError(`Issuance ${issuanceId} not found in the validated ledger`)
    if (issuance.Issuer !== options.wallet.classicAddress) {
      throw new IssuanceConfigurationError(
        `Issuance ${issuanceId} belongs to ${issuance.Issuer}, not ${options.wallet.classicAddress}`,
      )
    }
    if ((issuance.Flags & REQUIRED_ISSUANCE_FLAGS) !== REQUIRED_ISSUANCE_FLAGS) {
      throw new IssuanceConfigurationError(
        `Issuance ${issuanceId} lacks RequireAuth, CanLock or CanClawback (flags 0x${issuance.Flags.toString(16)})`,
      )
    }
    if ((issuance.Flags & FORBIDDEN_ISSUANCE_FLAGS) !== 0) {
      throw new IssuanceConfigurationError(
        `Issuance ${issuanceId} enables escrow, DEX trading or confidential balances, which would let a banned holder keep value`,
      )
    }
    if (issuance.DomainID) {
      throw new IssuanceConfigurationError(
        `Issuance ${issuanceId} uses a permissioned domain, which authorizes holders without the issuer's allowlist`,
      )
    }
    return new MptIssuer(options, issuance, issuanceId.toUpperCase())
  }

  // ---------------------------------------------------------------- allowlist

  /**
   * Adds a KYC-approved holder to the allowlist. The holder must first opt in by
   * submitting their own MPTokenAuthorize transaction.
   */
  async approveHolder(address: string): Promise<Outcome> {
    return this.#exclusive(async () => {
      this.#assertHolderAddress(address)
      await this.#assertNotBanned(address, 'approve')
      const token = await this.#requireMPToken(address)
      if (token.Flags & MPTokenFlags.lsfMPTAuthorized) return noop('holder is already approved')
      const result = await this.#submit({
        TransactionType: 'MPTokenAuthorize',
        Account: this.#wallet.classicAddress,
        MPTokenIssuanceID: this.issuanceId,
        Holder: address,
      })
      this.#audit({ action: 'approve-holder', holder: address, ...txRef(result) })
      return submitted(result)
    })
  }

  /**
   * Removes a holder from the allowlist. They can no longer send or receive the
   * token, but keep their current balance. Use {@link ban} to also zero the balance
   * and block re-approval.
   */
  async revokeApproval(address: string): Promise<Outcome> {
    return this.#exclusive(async () => this.#revokeApproval(address))
  }

  // ------------------------------------------------------------------ supply

  /** Sends newly issued tokens to an approved, unfrozen holder. */
  async issue(address: string, amount: string): Promise<Outcome> {
    return this.#exclusive(async () => {
      this.#assertHolderAddress(address)
      const units = this.#positiveUnits(amount)
      await this.#assertNotBanned(address, 'issue to')
      const token = await this.#requireMPToken(address)
      if (!(token.Flags & MPTokenFlags.lsfMPTAuthorized)) {
        throw new PolicyViolationError(`${address} is not approved to hold ${this.issuanceId}`)
      }
      // The ledger lets the issuer pay a locked holder. This module doesn't, so a freeze
      // also stops the holder from receiving.
      if (token.Flags & MPTokenFlags.lsfMPTLocked) throw new PolicyViolationError(`${address} is frozen`)
      const issuance = await this.#issuance()
      if (issuance.Flags & MPTokenIssuanceFlags.lsfMPTLocked) {
        throw new PolicyViolationError('The token is globally frozen')
      }
      const outstanding = parseLedgerAmount(issuance.OutstandingAmount)
      const maximum = issuance.MaximumAmount === undefined ? MAX_MPT_AMOUNT : parseLedgerAmount(issuance.MaximumAmount)
      if (outstanding + units > maximum) {
        throw new PolicyViolationError(`Issuing ${amount} would exceed the maximum supply`)
      }

      const result = await this.#submit({
        TransactionType: 'Payment',
        Account: this.#wallet.classicAddress,
        Destination: address,
        Amount: this.#mptAmount(units),
      })
      const delivered = (result.meta as { delivered_amount?: unknown }).delivered_amount as MPTAmount | undefined
      if (!delivered || delivered.mpt_issuance_id !== this.issuanceId || BigInt(delivered.value) !== units) {
        throw new PostConditionError(`Payment ${result.hash} delivered ${JSON.stringify(delivered)}, expected ${units}`)
      }
      this.#audit({ action: 'issue', holder: address, amount, ...txRef(result) })
      return submitted(result)
    })
  }

  // ---------------------------------------------------------------- clawback

  /**
   * Claws back exactly `amount` from a holder. Fails if the holder's balance is
   * smaller; use {@link clawbackAll} to take whatever they hold.
   */
  async clawback(address: string, amount: string): Promise<Outcome & { clawedBack?: string }> {
    return this.#exclusive(async () => {
      this.#assertHolderAddress(address)
      const units = this.#positiveUnits(amount)
      const balance = parseLedgerAmount((await this.#requireMPToken(address)).MPTAmount)
      if (units > balance) {
        throw new PolicyViolationError(
          `${address} holds ${fromBaseUnits(balance, this.assetScale)}, less than the requested ${amount}`,
        )
      }
      return this.#clawback(address, units, 'clawback')
    })
  }

  /** Claws back a holder's entire balance in one transaction, even if it changes in flight. */
  async clawbackAll(address: string): Promise<Outcome & { clawedBack?: string }> {
    return this.#exclusive(async () => {
      this.#assertHolderAddress(address)
      return this.#clawbackAll(address)
    })
  }

  // ------------------------------------------------------------------ freeze

  /**
   * Freezes one holder. On the ledger, a frozen holder can't send to or receive from
   * other holders. This module also refuses to issue to them. The ledger still lets a
   * frozen holder send tokens back to the issuer (redemption), and the issuer can
   * always claw back.
   */
  async freezeHolder(address: string): Promise<Outcome> {
    return this.#exclusive(async () => {
      this.#assertHolderAddress(address)
      return this.#freezeHolder(address)
    })
  }

  async unfreezeHolder(address: string): Promise<Outcome> {
    return this.#exclusive(async () => {
      this.#assertHolderAddress(address)
      await this.#assertNotBanned(address, 'unfreeze')
      const token = await this.#requireMPToken(address)
      if (!(token.Flags & MPTokenFlags.lsfMPTLocked)) return noop('holder is not frozen')
      const result = await this.#submit(this.#lockTx(MPTokenIssuanceSetFlags.tfMPTUnlock, address))
      this.#audit({ action: 'unfreeze-holder', holder: address, ...txRef(result) })
      return submitted(result)
    })
  }

  /** Freezes all transfers between holders, and all issuance through this module. */
  async freezeAll(): Promise<Outcome> {
    return this.#exclusive(async () => {
      if ((await this.#issuance()).Flags & MPTokenIssuanceFlags.lsfMPTLocked) return noop('already globally frozen')
      const result = await this.#submit(this.#lockTx(MPTokenIssuanceSetFlags.tfMPTLock))
      this.#audit({ action: 'global-freeze', ...txRef(result) })
      return submitted(result)
    })
  }

  async unfreezeAll(): Promise<Outcome> {
    return this.#exclusive(async () => {
      if (!((await this.#issuance()).Flags & MPTokenIssuanceFlags.lsfMPTLocked)) return noop('not globally frozen')
      const result = await this.#submit(this.#lockTx(MPTokenIssuanceSetFlags.tfMPTUnlock))
      this.#audit({ action: 'global-unfreeze', ...txRef(result) })
      return submitted(result)
    })
  }

  // --------------------------------------------------------------------- ban

  /**
   * Bans an address permanently.
   *
   * 1. Records the ban durably, so {@link approveHolder} refuses the address from now on.
   * 2. Freezes the holder, so they can't send to or receive from other holders.
   * 3. Revokes approval, so the ledger itself rejects any payment to or from them.
   * 4. Claws back the full balance.
   * 5. Re-reads the ledger and checks the holder has zero balance and no approval.
   *
   * Idempotent: a partly completed ban can be finished by calling it again.
   */
  async ban(address: string, reason: string): Promise<BanReport> {
    return this.#exclusive(async () => {
      this.#assertHolderAddress(address)
      if (!reason.trim()) throw new InvalidInputError('A ban reason is required')
      await this.#bans.add({ address, reason, bannedAt: new Date().toISOString() })
      const record = (await this.#bans.get(address))!
      this.#audit({ action: 'ban-recorded', holder: address, detail: reason })

      const steps: BanReport['steps'] = []
      if (await getMPTokenEntry(this.#client, this.issuanceId, address)) {
        steps.push({ step: 'freeze', outcome: await this.#freezeHolder(address) })
        steps.push({ step: 'revoke-approval', outcome: await this.#revokeApproval(address) })
        const claw = await this.#clawbackAll(address)
        steps.push({ step: 'clawback', outcome: claw, ...(claw.clawedBack !== undefined && { amount: claw.clawedBack }) })
      }

      const finalStatus = await this.getHolderStatus(address)
      if (finalStatus.balanceBaseUnits !== 0n || finalStatus.approved) {
        throw new PostConditionError(`Ban of ${address} incomplete: ${JSON.stringify(serializable(finalStatus))}`)
      }
      this.#audit({ action: 'ban-completed', holder: address })
      return { address, record, steps, finalStatus }
    })
  }

  async isBanned(address: string): Promise<boolean> {
    return this.#bans.isBanned(address)
  }

  // ------------------------------------------------------------------- reads

  async getHolderStatus(address: string): Promise<HolderStatus> {
    this.#assertHolderAddress(address)
    const [token, banned] = await Promise.all([
      getMPTokenEntry(this.#client, this.issuanceId, address),
      this.#bans.isBanned(address),
    ])
    const balance = parseLedgerAmount(token?.MPTAmount)
    return {
      address,
      optedIn: token !== null,
      approved: token !== null && (token.Flags & MPTokenFlags.lsfMPTAuthorized) !== 0,
      frozen: token !== null && (token.Flags & MPTokenFlags.lsfMPTLocked) !== 0,
      banned,
      balance: fromBaseUnits(balance, this.assetScale),
      balanceBaseUnits: balance,
    }
  }

  async getIssuanceStatus(): Promise<IssuanceStatus> {
    const issuance = await this.#issuance()
    const maximum = issuance.MaximumAmount === undefined ? MAX_MPT_AMOUNT : parseLedgerAmount(issuance.MaximumAmount)
    return {
      issuanceId: this.issuanceId,
      issuer: issuance.Issuer,
      assetScale: this.assetScale,
      globallyFrozen: (issuance.Flags & MPTokenIssuanceFlags.lsfMPTLocked) !== 0,
      outstanding: fromBaseUnits(parseLedgerAmount(issuance.OutstandingAmount), this.assetScale),
      maximum: fromBaseUnits(maximum, this.assetScale),
      flags: issuance.Flags,
    }
  }

  // ----------------------------------------------------------------- private

  async #revokeApproval(address: string): Promise<Outcome> {
    this.#assertHolderAddress(address)
    const token = await getMPTokenEntry(this.#client, this.issuanceId, address)
    if (!token) return noop('holder has not opted in, so is not approved')
    if (!(token.Flags & MPTokenFlags.lsfMPTAuthorized)) return noop('holder is not approved')
    const result = await this.#submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.#wallet.classicAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
    this.#audit({ action: 'revoke-approval', holder: address, ...txRef(result) })
    return submitted(result)
  }

  async #freezeHolder(address: string): Promise<Outcome> {
    const token = await this.#requireMPToken(address)
    if (token.Flags & MPTokenFlags.lsfMPTLocked) return noop('holder is already frozen')
    const result = await this.#submit(this.#lockTx(MPTokenIssuanceSetFlags.tfMPTLock, address))
    this.#audit({ action: 'freeze-holder', holder: address, ...txRef(result) })
    return submitted(result)
  }

  async #clawbackAll(address: string): Promise<Outcome & { clawedBack?: string }> {
    const token = await getMPTokenEntry(this.#client, this.issuanceId, address)
    if (!token || parseLedgerAmount(token.MPTAmount) === 0n) return noop('holder has no balance')
    // Asking for the maximum amount makes the ledger claw back the whole balance.
    return this.#clawback(address, MAX_MPT_AMOUNT, 'clawback-all')
  }

  async #clawback(address: string, units: bigint, action: string): Promise<Outcome & { clawedBack: string }> {
    const result = await this.#submit({
      TransactionType: 'Clawback',
      Account: this.#wallet.classicAddress,
      Holder: address,
      Amount: this.#mptAmount(units),
    })
    const clawedBack = fromBaseUnits(mptBalanceDecrease(result.meta, address, this.issuanceId), this.assetScale)
    this.#audit({ action, holder: address, amount: clawedBack, ...txRef(result) })
    return { ...submitted(result), clawedBack }
  }

  #lockTx(flag: MPTokenIssuanceSetFlags, holder?: string): SubmittableTransaction {
    return {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.#wallet.classicAddress,
      MPTokenIssuanceID: this.issuanceId,
      Flags: flag,
      ...(holder !== undefined && { Holder: holder }),
    }
  }

  async #submit(tx: SubmittableTransaction): Promise<ValidatedTx> {
    return submitOrThrow(this.#client, this.#wallet, tx, this.#networkId)
  }

  async #issuance(): Promise<MPTokenIssuance> {
    const issuance = await getIssuanceEntry(this.#client, this.issuanceId)
    if (!issuance) throw new IssuanceConfigurationError(`Issuance ${this.issuanceId} no longer exists`)
    return issuance
  }

  async #requireMPToken(address: string): Promise<MPTokenEntry> {
    const token = await getMPTokenEntry(this.#client, this.issuanceId, address)
    if (!token) {
      throw new PolicyViolationError(`${address} has not opted in to hold ${this.issuanceId} (no MPToken entry)`)
    }
    return token
  }

  async #assertNotBanned(address: string, action: string): Promise<void> {
    if (await this.#bans.isBanned(address)) throw new PolicyViolationError(`Refusing to ${action} banned address ${address}`)
  }

  #assertHolderAddress(address: string): void {
    if (!isValidClassicAddress(address)) throw new InvalidInputError(`Invalid classic address ${address}`)
    if (address === this.#wallet.classicAddress) throw new InvalidInputError('The issuer cannot be a holder')
  }

  #positiveUnits(amount: string): bigint {
    const units = toBaseUnits(amount, this.assetScale)
    if (units === 0n) throw new InvalidInputError('Amount must be greater than zero')
    return units
  }

  #mptAmount(units: bigint): MPTAmount {
    return { mpt_issuance_id: this.issuanceId, value: units.toString() }
  }

  #audit(event: Omit<AuditEvent, 'issuanceId'>): void {
    try {
      this.#onAudit?.({ issuanceId: this.issuanceId, ...event })
    } catch {
      // An audit sink failure must not hide the outcome of a transaction that already validated.
    }
  }

  /** Runs `fn` after all previously queued operations, one at a time. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn)
    this.#queue = run.catch(() => undefined)
    return run
  }
}

function submitted(result: ValidatedTx): Outcome {
  return { status: 'submitted', hash: result.hash, ledgerIndex: result.ledgerIndex }
}

function noop(reason: string): Outcome {
  return { status: 'noop', reason }
}

function txRef(result: ValidatedTx): { txHash: string; ledgerIndex: number } {
  return { txHash: result.hash, ledgerIndex: result.ledgerIndex }
}

/** Amount by which a holder's MPT balance fell in a transaction, read from its metadata. */
function mptBalanceDecrease(meta: TransactionMetadata, holder: string, issuanceId: string): bigint {
  for (const node of meta.AffectedNodes) {
    if (!('ModifiedNode' in node)) continue
    const { LedgerEntryType, FinalFields, PreviousFields } = node.ModifiedNode
    if (LedgerEntryType !== 'MPToken' || FinalFields?.['Account'] !== holder) continue
    if (String(FinalFields['MPTokenIssuanceID']).toUpperCase() !== issuanceId) continue
    if (!PreviousFields || !('MPTAmount' in PreviousFields)) return 0n
    return parseLedgerAmount(PreviousFields['MPTAmount']) - parseLedgerAmount(FinalFields['MPTAmount'])
  }
  return 0n
}

function serializable(status: HolderStatus): Record<string, unknown> {
  return { ...status, balanceBaseUnits: status.balanceBaseUnits.toString() }
}
