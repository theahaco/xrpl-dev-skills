/**
 * Issuer-side controls for a regulated, stablecoin-style Multi-Purpose Token (MPT)
 * on the XRP Ledger.
 *
 * Backed by the MPTokensV1 amendment (transactions: MPTokenIssuanceCreate,
 * MPTokenIssuanceSet, MPTokenAuthorize) and the Clawback amendment. Both are
 * enabled on XRPL testnet as of this writing.
 *
 * Compliance controls exposed:
 *  - Allowlist: RequireAuth + MPTokenAuthorize (issuer must authorize each holder)
 *  - Per-holder freeze: MPTokenIssuanceSet tfMPTLock/tfMPTUnlock with Holder set
 *  - Global freeze: MPTokenIssuanceSet tfMPTLock/tfMPTUnlock with Holder omitted
 *  - Clawback: Clawback transaction (requires tfMPTCanClawback at issuance)
 *  - Ban: clawback to zero + individual freeze + de-authorize, so the address
 *    can neither hold nor receive the token again
 */

import {
  Client,
  LedgerEntry,
  Wallet,
  encodeMPTokenMetadata,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type MPTokenIssuanceSet,
  type MPTokenMetadata,
  type Clawback,
  type Payment,
  type SubmittableTransaction,
  type TxResponse,
} from 'xrpl'

/** Thrown when a submitted compliance transaction does not succeed on-ledger. */
export class ComplianceTransactionError extends Error {
  public readonly transactionType: string
  public readonly engineResult: string

  public constructor(transactionType: string, engineResult: string, message?: string) {
    super(message ?? `${transactionType} failed with engine result ${engineResult}`)
    this.name = 'ComplianceTransactionError'
    this.transactionType = transactionType
    this.engineResult = engineResult
  }
}

/** Thrown when a method is called before the issuance has been created. */
export class IssuanceNotInitializedError extends Error {
  public constructor() {
    super('No MPT issuance is associated with this issuer instance yet. Call createIssuance() first.')
    this.name = 'IssuanceNotInitializedError'
  }
}

export interface CreateIssuanceParams {
  /** Decimal places for display purposes. Defaults to 0 (whole units only). */
  assetScale?: number
  /** Maximum issuable supply, as a decimal string. Defaults to a generous fixed cap. */
  maximumAmount?: string
  /** Secondary-sale transfer fee in 0.001% increments (0-50000). Defaults to 0. */
  transferFee?: number
  /** Optional XLS-89 metadata describing the token; encoded to hex automatically. */
  metadata?: MPTokenMetadata
}

export interface IssuanceState {
  issuanceId: string
  issuer: string
  assetScale: number
  maximumAmount?: string
  outstandingAmount: string
  transferFee: number
  /** True if the entire issuance is currently globally frozen. */
  globallyLocked: boolean
  requireAuth: boolean
  canLock: boolean
  canClawback: boolean
  canTransfer: boolean
}

export interface HolderState {
  /** Whether an MPToken object exists for this holder (i.e. they have opted in). */
  holds: boolean
  /** Whether the issuer has allowlisted (authorized) this holder. */
  authorized: boolean
  /** Whether this holder is individually frozen. */
  locked: boolean
  /** Current balance, as a decimal string in base units. "0" if no MPToken object exists. */
  balance: string
}

// The MPToken (per-holder) ledger object does not have a flags enum exported by
// xrpl.js the way MPTokenIssuance does, so the two documented bit values are
// declared locally. See https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken
const MPTOKEN_FLAG_LOCKED = 0x00000001
const MPTOKEN_FLAG_AUTHORIZED = 0x00000002

function hasFlag(flags: number, flag: number): boolean {
  // eslint-disable-next-line no-bitwise -- bitmask check against a protocol-defined flag
  return (flags & flag) !== 0
}

function isEntryNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const data = (error as { data?: unknown }).data
  if (data == null || typeof data !== 'object') {
    return false
  }
  return (data as { error?: unknown }).error === 'entryNotFound'
}

function assertPositiveIntegerString(value: string, label: string): void {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new RangeError(`${label} must be a positive integer string (got ${JSON.stringify(value)})`)
  }
}

/**
 * Issuer-side handle for a single regulated MPT issuance. All methods sign
 * with the issuer wallet supplied at construction time and wait for the
 * resulting transaction to reach a validated ledger before resolving.
 */
export class MptComplianceIssuer {
  private readonly client: Client
  private readonly issuerWallet: Wallet
  private issuanceId: string | undefined

  public constructor(client: Client, issuerWallet: Wallet, issuanceId?: string) {
    this.client = client
    this.issuerWallet = issuerWallet
    this.issuanceId = issuanceId
  }

  public get address(): string {
    return this.issuerWallet.address
  }

  public get id(): string {
    if (this.issuanceId == null) {
      throw new IssuanceNotInitializedError()
    }
    return this.issuanceId
  }

  private async submit<T extends SubmittableTransaction>(tx: T): Promise<TxResponse<T>> {
    const response = await this.client.submitAndWait(tx, { wallet: this.issuerWallet, autofill: true })
    const meta = response.result.meta
    if (meta == null || typeof meta === 'string') {
      throw new ComplianceTransactionError(tx.TransactionType, 'UNKNOWN', `${tx.TransactionType}: no transaction metadata returned`)
    }
    if (meta.TransactionResult !== 'tesSUCCESS') {
      throw new ComplianceTransactionError(tx.TransactionType, meta.TransactionResult)
    }
    if (response.result.validated !== true) {
      throw new ComplianceTransactionError(tx.TransactionType, meta.TransactionResult, `${tx.TransactionType}: response was not from a validated ledger`)
    }
    return response
  }

  /**
   * Creates the MPT issuance with every compliance control this module
   * supports enabled: holder allowlisting (RequireAuth), per-holder and
   * global freeze (CanLock), clawback (CanClawback), and transfers between
   * approved holders (CanTransfer).
   *
   * @returns The new MPTokenIssuanceID.
   */
  public async createIssuance(params: CreateIssuanceParams = {}): Promise<string> {
    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: this.issuerWallet.address,
      AssetScale: params.assetScale ?? 0,
      MaximumAmount: params.maximumAmount ?? '1000000000000',
      Flags: {
        tfMPTCanLock: true,
        tfMPTRequireAuth: true,
        tfMPTCanClawback: true,
        tfMPTCanTransfer: true,
      },
    }
    if (params.transferFee != null) {
      tx.TransferFee = params.transferFee
    }
    if (params.metadata != null) {
      tx.MPTokenMetadata = encodeMPTokenMetadata(params.metadata)
    }

    const response = await this.submit(tx)
    const meta = response.result.meta as { mpt_issuance_id?: string }
    const issuanceId = meta.mpt_issuance_id
    if (issuanceId == null) {
      throw new ComplianceTransactionError(
        'MPTokenIssuanceCreate',
        'tesSUCCESS',
        'MPTokenIssuanceCreate succeeded but the ledger did not return an mpt_issuance_id',
      )
    }
    this.issuanceId = issuanceId
    return issuanceId
  }

  /**
   * Allowlists a holder who has already opted in (submitted their own
   * MPTokenAuthorize) and passed KYC. Required before they can receive any
   * tokens, since the issuance was created with RequireAuth.
   */
  public async authorizeHolder(holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.id,
      Holder: holderAddress,
    }
    await this.submit(tx)
  }

  /** Removes a holder from the allowlist. They keep any balance already held, but can no longer receive more. */
  public async unauthorizeHolder(holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.id,
      Holder: holderAddress,
      Flags: { tfMPTUnauthorize: true },
    }
    await this.submit(tx)
  }

  /** Issues (mints and sends) `amount` base units of the token to an approved holder. */
  public async issue(holderAddress: string, amount: string): Promise<TxResponse<Payment>> {
    assertPositiveIntegerString(amount, 'amount')
    const tx: Payment = {
      TransactionType: 'Payment',
      Account: this.issuerWallet.address,
      Destination: holderAddress,
      Amount: { mpt_issuance_id: this.id, value: amount },
    }
    const response = await this.submit(tx)

    const meta = response.result.meta as { delivered_amount?: { value?: string } | string }
    const delivered = meta.delivered_amount
    const deliveredValue = typeof delivered === 'object' ? delivered.value : undefined
    if (deliveredValue !== amount) {
      throw new ComplianceTransactionError(
        'Payment',
        'tesSUCCESS',
        `Payment reported tesSUCCESS but delivered_amount (${String(deliveredValue)}) did not match the requested amount (${amount})`,
      )
    }
    return response
  }

  /** Claws back `amount` base units of the token from a holder, regardless of their consent. */
  public async clawback(holderAddress: string, amount: string): Promise<void> {
    assertPositiveIntegerString(amount, 'amount')
    const tx: Clawback = {
      TransactionType: 'Clawback',
      Account: this.issuerWallet.address,
      Holder: holderAddress,
      Amount: { mpt_issuance_id: this.id, value: amount },
    }
    await this.submit(tx)
  }

  /** Freezes a single holder: they can neither send nor receive the token until unfrozen. */
  public async freezeHolder(holderAddress: string): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.id,
      Holder: holderAddress,
      Flags: { tfMPTLock: true },
    }
    await this.submit(tx)
  }

  /** Lifts an individual freeze on a holder. */
  public async unfreezeHolder(holderAddress: string): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.id,
      Holder: holderAddress,
      Flags: { tfMPTUnlock: true },
    }
    await this.submit(tx)
  }

  /** Freezes all movement of the token, for every holder, e.g. during an incident. */
  public async globalFreeze(): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.id,
      Flags: { tfMPTLock: true },
    }
    await this.submit(tx)
  }

  /** Lifts a global freeze. */
  public async globalUnfreeze(): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.id,
      Flags: { tfMPTUnlock: true },
    }
    await this.submit(tx)
  }

  /**
   * Bans a holder: claws back their full balance, freezes their MPToken so it
   * cannot move even if re-authorized by mistake, and removes them from the
   * allowlist so RequireAuth blocks any future payment to them. The address
   * ends up holding zero tokens and cannot receive the token again unless an
   * operator explicitly re-authorizes and unfreezes it.
   */
  public async banHolder(holderAddress: string): Promise<void> {
    const state = await this.getHolderState(holderAddress)
    if (!state.holds) {
      // Never opted in: already holds none and, being unauthorized by
      // default under RequireAuth, cannot receive the token. Nothing to do.
      return
    }

    if (BigInt(state.balance) > 0n) {
      await this.clawback(holderAddress, state.balance)
    }
    if (!state.locked) {
      await this.freezeHolder(holderAddress)
    }
    if (state.authorized) {
      await this.unauthorizeHolder(holderAddress)
    }
  }

  /** Reads the current on-ledger state of the issuance, decoding its flags. */
  public async getIssuanceState(): Promise<IssuanceState> {
    const response = await this.client.request({
      command: 'ledger_entry',
      mpt_issuance: this.id,
    })
    const node = response.result.node as unknown as LedgerEntry.MPTokenIssuance
    const flags = node.Flags

    return {
      issuanceId: this.id,
      issuer: node.Issuer,
      assetScale: node.AssetScale ?? 0,
      maximumAmount: node.MaximumAmount,
      outstandingAmount: node.OutstandingAmount ?? '0',
      transferFee: node.TransferFee ?? 0,
      globallyLocked: hasFlag(flags, LedgerEntry.MPTokenIssuanceFlags.lsfMPTLocked),
      requireAuth: hasFlag(flags, LedgerEntry.MPTokenIssuanceFlags.lsfMPTRequireAuth),
      canLock: hasFlag(flags, LedgerEntry.MPTokenIssuanceFlags.lsfMPTCanLock),
      canClawback: hasFlag(flags, LedgerEntry.MPTokenIssuanceFlags.lsfMPTCanClawback),
      canTransfer: hasFlag(flags, LedgerEntry.MPTokenIssuanceFlags.lsfMPTCanTransfer),
    }
  }

  /** Reads the current on-ledger state of a single holder's MPToken, decoding its flags. */
  public async getHolderState(holderAddress: string): Promise<HolderState> {
    try {
      const response = await this.client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: this.id, account: holderAddress },
      })
      const node = response.result.node as unknown as LedgerEntry.MPToken
      return {
        holds: true,
        authorized: hasFlag(node.Flags, MPTOKEN_FLAG_AUTHORIZED),
        locked: hasFlag(node.Flags, MPTOKEN_FLAG_LOCKED),
        // rippled omits MPTAmount from the ledger entry entirely when the
        // balance is zero, rather than serializing "0".
        balance: node.MPTAmount ?? '0',
      }
    } catch (error) {
      if (isEntryNotFoundError(error)) {
        return { holds: false, authorized: false, locked: false, balance: '0' }
      }
      throw error
    }
  }
}

/**
 * Holder-side action: opts a holder's own account in to an MPT issuance so it
 * can later be allowlisted by the issuer. This is signed by the holder, not
 * the issuer, since only the holder can consent to hold a token; it is
 * exported separately from {@link MptComplianceIssuer} because an issuer
 * backend does not hold custody of holder keys in a production deployment.
 */
export async function optInToIssuance(client: Client, holderWallet: Wallet, issuanceId: string): Promise<void> {
  const tx: MPTokenAuthorize = {
    TransactionType: 'MPTokenAuthorize',
    Account: holderWallet.address,
    MPTokenIssuanceID: issuanceId,
  }
  const response = await client.submitAndWait(tx, { wallet: holderWallet, autofill: true })
  const meta = response.result.meta
  if (meta == null || typeof meta === 'string' || meta.TransactionResult !== 'tesSUCCESS') {
    const engineResult = meta == null || typeof meta === 'string' ? 'UNKNOWN' : meta.TransactionResult
    throw new ComplianceTransactionError('MPTokenAuthorize', engineResult, `Holder opt-in failed: ${engineResult}`)
  }
}
