import {
  Client,
  Wallet,
  validate,
  parseMPTokenIssuanceFlags,
  MPTokenIssuanceCreate,
  MPTokenIssuanceCreateFlagsInterface,
  MPTokenAuthorize,
  MPTokenIssuanceSet,
  Clawback,
  Payment,
  LedgerEntry,
  SubmittableTransaction,
  TxResponse,
} from 'xrpl'

type MPTokenIssuance = LedgerEntry.MPTokenIssuance
type MPToken = LedgerEntry.MPToken

/**
 * The MPToken ledger object (per-holder) does not have an exported flag
 * parser in xrpl.js, so the two flag bits are reproduced here from the
 * MPToken ledger entry spec (xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken).
 */
const MPTOKEN_LSF_LOCKED = 0x00000001
const MPTOKEN_LSF_AUTHORIZED = 0x00000002

/** Largest amount representable in an MPT balance field (2^63 - 1). */
const MAX_MPT_AMOUNT = '9223372036854775807'

export class MptIssuerError extends Error {
  constructor(
    message: string,
    public readonly transactionResult?: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'MptIssuerError'
  }
}

export interface CreateIssuanceOptions {
  /** Non-negative integer decimal places for display purposes. Defaults to 0. */
  assetScale?: number
  /** Maximum amount that may ever be outstanding. Defaults to the protocol maximum. */
  maximumAmount?: string
  /** Transfer fee in 0.001% increments (0-50000). Requires transfers between holders to be allowed. */
  transferFeeBasisPoints?: number
  /** Hex-encoded metadata blob (max 1024 bytes), ideally XLS-89 JSON. */
  metadata?: string
  /** Whether holders may pay each other directly (not just the issuer). Defaults to true. */
  allowHolderToHolderTransfer?: boolean
}

export interface MptIssuanceInfo {
  issuanceId: string
  txHash: string
}

/**
 * Reusable issuer-side controls for a single regulated, allow-listed Multi-Purpose
 * Token (MPT) issuance. Wraps the raw MPTokenIssuanceCreate / MPTokenAuthorize /
 * MPTokenIssuanceSet / Clawback / Payment transactions with the compliance
 * workflows a stablecoin-style issuer needs: allow-listing, per-holder and
 * global freeze, clawback, and permanent bans.
 *
 * One instance is bound to one issuer wallet; callers may manage multiple
 * issuances (e.g. multiple tokens) by calling `createIssuance` more than once
 * and passing the resulting `issuanceId` back into the other methods.
 */
export class MptIssuer {
  public constructor(
    private readonly client: Client,
    private readonly issuer: Wallet,
  ) {}

  public get issuerAddress(): string {
    return this.issuer.address
  }

  /**
   * Creates a new MPT issuance with every compliance control enabled:
   * - `tfMPTRequireAuth` so only issuer-approved (allow-listed) holders can hold it.
   * - `tfMPTCanLock` so holders (or the whole issuance) can be frozen and unfrozen.
   * - `tfMPTCanClawback` so the issuer can claw back tokens from any holder.
   */
  public async createIssuance(
    options: CreateIssuanceOptions = {},
  ): Promise<MptIssuanceInfo> {
    const flags: MPTokenIssuanceCreateFlagsInterface = {
      tfMPTCanLock: true,
      tfMPTRequireAuth: true,
      tfMPTCanClawback: true,
      tfMPTCanTransfer: options.allowHolderToHolderTransfer ?? true,
    }

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: this.issuer.address,
      Flags: flags,
    }
    if (options.assetScale !== undefined) {
      tx.AssetScale = options.assetScale
    }
    if (options.maximumAmount !== undefined) {
      tx.MaximumAmount = options.maximumAmount
    }
    if (options.transferFeeBasisPoints !== undefined) {
      tx.TransferFee = options.transferFeeBasisPoints
    }
    if (options.metadata !== undefined) {
      tx.MPTokenMetadata = options.metadata
    }

    const response = await this.submit(tx, this.issuer)
    const meta = response.result.meta
    const issuanceId =
      meta != null && typeof meta !== 'string' ? meta.mpt_issuance_id : undefined
    if (issuanceId == null) {
      throw new MptIssuerError(
        'MPTokenIssuanceCreate succeeded but the response did not include an mpt_issuance_id',
        undefined,
        response.result,
      )
    }
    return { issuanceId, txHash: response.result.hash }
  }

  // ---------------------------------------------------------------------
  // Allow-list (KYC approval)
  // ---------------------------------------------------------------------

  /**
   * Holder-side opt-in: signals that `holder` is willing to hold this MPT.
   * This must happen before the issuer can approve the holder, and creates
   * a zero-balance, unauthorized MPToken entry on the holder's account.
   */
  public async requestHolderOptIn(
    holder: Wallet,
    issuanceId: string,
  ): Promise<TxResponse<MPTokenAuthorize>> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: holder.address,
      MPTokenIssuanceID: issuanceId,
    }
    return this.submit(tx, holder)
  }

  /**
   * Issuer-side approval: grants `holderAddress` permission to hold the MPT
   * (sets `lsfMPTAuthorized` on their MPToken entry). Represents the outcome
   * of a successful KYC check. The holder must have already opted in via
   * `requestHolderOptIn`.
   */
  public async approveHolder(
    issuanceId: string,
    holderAddress: string,
  ): Promise<TxResponse<MPTokenAuthorize>> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuer.address,
      MPTokenIssuanceID: issuanceId,
      Holder: holderAddress,
    }
    return this.submit(tx, this.issuer);
  }

  /**
   * Issuer-side revocation: unsets `lsfMPTAuthorized` on `holderAddress`'s
   * MPToken entry, without touching their balance. Because the issuance
   * requires authorization, a revoked holder can no longer send or receive
   * the token until re-approved. Used as the second half of `banHolder`.
   */
  public async revokeHolderAuthorization(
    issuanceId: string,
    holderAddress: string,
  ): Promise<TxResponse<MPTokenAuthorize>> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuer.address,
      MPTokenIssuanceID: issuanceId,
      Holder: holderAddress,
      Flags: { tfMPTUnauthorize: true },
    }
    return this.submit(tx, this.issuer)
  }

  // ---------------------------------------------------------------------
  // Freeze (per-holder and global)
  // ---------------------------------------------------------------------

  /** Freezes a single holder: they can no longer send or receive the MPT. */
  public async freezeHolder(
    issuanceId: string,
    holderAddress: string,
  ): Promise<TxResponse<MPTokenIssuanceSet>> {
    return this.setLock(issuanceId, true, holderAddress)
  }

  /** Reverses `freezeHolder`. */
  public async unfreezeHolder(
    issuanceId: string,
    holderAddress: string,
  ): Promise<TxResponse<MPTokenIssuanceSet>> {
    return this.setLock(issuanceId, false, holderAddress)
  }

  /** Freezes all movement of the token, for every holder, issuance-wide. */
  public async globalFreeze(
    issuanceId: string,
  ): Promise<TxResponse<MPTokenIssuanceSet>> {
    return this.setLock(issuanceId, true)
  }

  /** Reverses `globalFreeze`. */
  public async globalUnfreeze(
    issuanceId: string,
  ): Promise<TxResponse<MPTokenIssuanceSet>> {
    return this.setLock(issuanceId, false)
  }

  private async setLock(
    issuanceId: string,
    lock: boolean,
    holderAddress?: string,
  ): Promise<TxResponse<MPTokenIssuanceSet>> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuer.address,
      MPTokenIssuanceID: issuanceId,
      Flags: lock ? { tfMPTLock: true } : { tfMPTUnlock: true },
    }
    if (holderAddress !== undefined) {
      tx.Holder = holderAddress
    }
    return this.submit(tx, this.issuer)
  }

  // ---------------------------------------------------------------------
  // Clawback and bans
  // ---------------------------------------------------------------------

  /** Claws back an exact amount of the token from a holder's balance. */
  public async clawback(
    issuanceId: string,
    holderAddress: string,
    value: string,
  ): Promise<TxResponse<Clawback>> {
    const tx: Clawback = {
      TransactionType: 'Clawback',
      Account: this.issuer.address,
      Holder: holderAddress,
      Amount: { mpt_issuance_id: issuanceId, value },
    }
    return this.submit(tx, this.issuer)
  }

  /**
   * Claws back the holder's entire current balance. A clawback `Amount` that
   * exceeds the actual balance simply claws back everything, so this is safe
   * to call even if the balance changes concurrently; if the holder's balance
   * is already zero, no transaction is submitted.
   */
  public async clawbackAll(
    issuanceId: string,
    holderAddress: string,
  ): Promise<TxResponse<Clawback> | undefined> {
    const balance = await this.getBalance(issuanceId, holderAddress)
    if (BigInt(balance) === 0n) {
      return undefined
    }
    return this.clawback(issuanceId, holderAddress, MAX_MPT_AMOUNT)
  }

  /**
   * Permanently bans a holder: claws back their entire balance (if any) and
   * revokes their authorization, so they end up holding none of the token
   * and cannot be paid it again unless explicitly re-approved.
   */
  public async banHolder(
    issuanceId: string,
    holderAddress: string,
  ): Promise<void> {
    await this.clawbackAll(issuanceId, holderAddress)
    await this.revokeHolderAuthorization(issuanceId, holderAddress)
  }

  // ---------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------

  /** Sends `value` of the MPT from `from` to `destination`. */
  public async pay(
    from: Wallet,
    issuanceId: string,
    destination: string,
    value: string,
  ): Promise<TxResponse<Payment>> {
    const tx: Payment = {
      TransactionType: 'Payment',
      Account: from.address,
      Destination: destination,
      Amount: { mpt_issuance_id: issuanceId, value },
    }
    return this.submit(tx, from)
  }

  /** Issues (pays) `value` of the MPT from the issuer to `destination`. */
  public async issueTo(
    issuanceId: string,
    destination: string,
    value: string,
  ): Promise<TxResponse<Payment>> {
    return this.pay(this.issuer, issuanceId, destination, value)
  }

  // ---------------------------------------------------------------------
  // Ledger state helpers
  // ---------------------------------------------------------------------

  public async getIssuance(issuanceId: string): Promise<MPTokenIssuance | null> {
    try {
      const response = await this.client.request({
        command: 'ledger_entry',
        mpt_issuance: issuanceId,
        ledger_index: 'validated',
      })
      return response.result.node as unknown as MPTokenIssuance
    } catch (error) {
      if (isEntryNotFound(error)) {
        return null
      }
      throw error
    }
  }

  public async getMPToken(
    issuanceId: string,
    holderAddress: string,
  ): Promise<MPToken | null> {
    try {
      const response = await this.client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: issuanceId, account: holderAddress },
        ledger_index: 'validated',
      })
      return response.result.node as unknown as MPToken
    } catch (error) {
      if (isEntryNotFound(error)) {
        return null
      }
      throw error
    }
  }

  public async getBalance(
    issuanceId: string,
    holderAddress: string,
  ): Promise<string> {
    const mptoken = await this.getMPToken(issuanceId, holderAddress)
    return mptoken?.MPTAmount ?? '0'
  }

  public async isGloballyFrozen(issuanceId: string): Promise<boolean> {
    const issuance = await this.getIssuance(issuanceId)
    if (issuance == null) {
      throw new MptIssuerError(`MPTokenIssuance ${issuanceId} not found`)
    }
    return Boolean(parseMPTokenIssuanceFlags(issuance.Flags).lsfMPTLocked)
  }

  public async isHolderFrozen(
    issuanceId: string,
    holderAddress: string,
  ): Promise<boolean> {
    const mptoken = await this.getMPToken(issuanceId, holderAddress)
    if (mptoken == null) {
      return false
    }
    // eslint-disable-next-line no-bitwise -- bit flag check
    return (mptoken.Flags & MPTOKEN_LSF_LOCKED) !== 0
  }

  public async isHolderAuthorized(
    issuanceId: string,
    holderAddress: string,
  ): Promise<boolean> {
    const mptoken = await this.getMPToken(issuanceId, holderAddress)
    if (mptoken == null) {
      return false
    }
    // eslint-disable-next-line no-bitwise -- bit flag check
    return (mptoken.Flags & MPTOKEN_LSF_AUTHORIZED) !== 0
  }

  // ---------------------------------------------------------------------
  // Submission plumbing
  // ---------------------------------------------------------------------

  private async submit<T extends SubmittableTransaction>(
    tx: T,
    wallet: Wallet,
  ): Promise<TxResponse<T>> {
    validate(tx as unknown as Record<string, unknown>)
    const response = await this.client.submitAndWait(tx, {
      wallet,
      autofill: true,
    })
    const meta = response.result.meta
    const transactionResult =
      meta != null && typeof meta !== 'string' ? meta.TransactionResult : undefined
    if (transactionResult !== 'tesSUCCESS') {
      throw new MptIssuerError(
        `${tx.TransactionType} failed with result ${String(transactionResult)}`,
        transactionResult,
        response.result,
      )
    }
    return response
  }
}

function isEntryNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'data' in error &&
    typeof (error as { data?: unknown }).data === 'object' &&
    (error as { data?: { error?: unknown } }).data?.error === 'entryNotFound'
  )
}
