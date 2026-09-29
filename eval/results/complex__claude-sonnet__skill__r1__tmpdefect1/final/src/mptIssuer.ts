import {
  isValidClassicAddress,
  type Client,
  type Clawback,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type MPTokenIssuanceSet,
  type Payment,
  type TxResponse,
  type Wallet,
} from 'xrpl'

import { submitAndVerify } from './txSubmit.js'
import {
  NON_EXISTENT_HOLDER_STATE,
  type HolderState,
  type IssuanceConfig,
  type IssuanceState,
} from './types.js'

const MPT_FLAGS = {
  tfMPTCanLock: 0x00000002,
  tfMPTRequireAuth: 0x00000004,
  tfMPTCanTransfer: 0x00000020,
  tfMPTCanClawback: 0x00000040,
} as const

const MPT_ISSUANCE_FLAGS = {
  lsfMPTLocked: 0x00000001,
  lsfMPTCanLock: 0x00000002,
  lsfMPTRequireAuth: 0x00000004,
  lsfMPTCanTransfer: 0x00000020,
  lsfMPTCanClawback: 0x00000040,
} as const

// The MPToken (per-holder) ledger object uses its own, unrelated flag bits.
const MPTOKEN_FLAGS = {
  lsfMPTLocked: 0x00000001,
  lsfMPTAuthorized: 0x00000002,
} as const

const UINT64_MAX = 9223372036854775807n

function assertValidHolderAddress(address: string): void {
  if (!isValidClassicAddress(address)) {
    throw new Error(`Not a valid XRPL classic address: ${address}`)
  }
}

function assertNonNegativeIntegerAmount(value: string): void {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`Amount must be a non-negative integer string, got: ${value}`)
  }
  if (BigInt(value) > UINT64_MAX) {
    throw new Error(`Amount exceeds the maximum representable MPT amount: ${value}`)
  }
}

function hasFlag(flags: number, bit: number): boolean {
  // eslint-disable-next-line no-bitwise -- flag bit test
  return (flags & bit) !== 0
}

/**
 * Thrown by {@link MptComplianceIssuer.send} when a compliance control
 * would block the transfer. Raised locally, before anything is submitted
 * to the network — see the note on `send` for why this check exists in
 * the application layer instead of relying on the protocol alone.
 */
export class ComplianceViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComplianceViolationError'
  }
}

/**
 * Issuer-side compliance controls for a single Multi-Purpose Token (MPT)
 * issuance on the XRP Ledger: allowlisting, clawback, bans, per-holder
 * freeze, and global freeze.
 *
 * All mutating methods sign with the issuer wallet, submit, and wait for a
 * validated `tesSUCCESS` result before returning; they throw
 * {@link TransactionFailedError} (from `./txSubmit.js`) otherwise. Nothing in
 * this module ever reports success based on submission alone.
 *
 * This class only performs issuer-side actions. A holder must still submit
 * their own `MPTokenAuthorize` to opt in before the issuer can approve them
 * (see `optInHolder` in `holder.ts`) — the issuer cannot do that on a
 * holder's behalf, since it requires the holder's signature.
 *
 * ### A protocol nuance that shapes `send()`
 *
 * On the ledger, individual and global lock only block transfers *between
 * two non-issuer holders* — confirmed empirically against testnet. A
 * locked or globally-frozen holder can still receive a `Payment` sent
 * directly by the issuer, and can still send directly to the issuer (an
 * intentional redemption carve-out). Allowlist revocation (unauthorize)
 * has no such carve-out and blocks every direction unconditionally, which
 * is why {@link MptComplianceIssuer.banHolder} needs no extra help.
 *
 * So that "frozen means frozen" holds for every transfer this module
 * originates, `send()` independently checks the destination's freeze and
 * authorization state — and the issuance's global-freeze state — before
 * submitting, and refuses with {@link ComplianceViolationError} if either
 * would otherwise let the protocol carve-out through. This cannot reach
 * into a holder's own wallet, so a locked holder redeeming directly to the
 * issuer via their own signature remains possible; that is the one
 * transfer this module cannot and should not prevent.
 */
export class MptComplianceIssuer {
  private readonly client: Client
  private readonly issuer: Wallet
  private issuanceId: string | undefined

  private constructor(client: Client, issuer: Wallet, issuanceId?: string) {
    this.client = client
    this.issuer = issuer
    this.issuanceId = issuanceId
  }

  /** Wrap an issuance that has not been created yet. */
  static forNewIssuance(client: Client, issuer: Wallet): MptComplianceIssuer {
    return new MptComplianceIssuer(client, issuer)
  }

  /** Wrap an issuance that already exists on the ledger. */
  static forExistingIssuance(
    client: Client,
    issuer: Wallet,
    issuanceId: string,
  ): MptComplianceIssuer {
    return new MptComplianceIssuer(client, issuer, issuanceId)
  }

  /** The MPTokenIssuanceID. Throws if `createIssuance` has not run yet. */
  get id(): string {
    if (this.issuanceId == null) {
      throw new Error('Issuance has not been created yet; call createIssuance() first.')
    }
    return this.issuanceId
  }

  get issuerAddress(): string {
    return this.issuer.classicAddress
  }

  /**
   * Creates the MPT issuance with every compliance control enabled:
   * allowlisting (RequireAuth), per-holder and global freeze (CanLock), and
   * clawback (CanClawback). Holder-to-holder transfer is enabled by default
   * so the token behaves like a normal transferable stablecoin; set
   * `allowHolderToHolderTransfer: false` to force every movement through
   * the issuer instead.
   *
   * This is the only transaction that can set these flags — they cannot be
   * turned on later — so it must be right the first time.
   */
  async createIssuance(config: IssuanceConfig = {}): Promise<string> {
    if (this.issuanceId != null) {
      throw new Error(`Issuance already created: ${this.issuanceId}`)
    }

    const allowTransfer = config.allowHolderToHolderTransfer ?? true

    let flags =
      MPT_FLAGS.tfMPTCanLock | MPT_FLAGS.tfMPTRequireAuth | MPT_FLAGS.tfMPTCanClawback
    if (allowTransfer) {
      // eslint-disable-next-line no-bitwise -- building a flag bitmask
      flags |= MPT_FLAGS.tfMPTCanTransfer
    }

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: this.issuer.classicAddress,
      Flags: flags,
      ...(config.assetScale != null ? { AssetScale: config.assetScale } : {}),
      ...(config.maximumAmount != null ? { MaximumAmount: config.maximumAmount } : {}),
      ...(config.transferFee != null ? { TransferFee: config.transferFee } : {}),
      ...(config.metadataHex != null ? { MPTokenMetadata: config.metadataHex } : {}),
    }

    const response = await submitAndVerify(this.client, this.issuer, tx)
    const meta = response.result.meta
    const issuanceId =
      meta != null && typeof meta !== 'string' && 'mpt_issuance_id' in meta
        ? (meta as { mpt_issuance_id?: string }).mpt_issuance_id
        : undefined

    if (issuanceId == null) {
      throw new Error(
        'MPTokenIssuanceCreate succeeded but no mpt_issuance_id was returned in the metadata.',
      )
    }

    this.issuanceId = issuanceId
    return issuanceId
  }

  /**
   * Allowlists a holder who has already opted in (submitted their own
   * `MPTokenAuthorize`). Until this runs, the holder's MPToken exists but
   * is unauthorized and cannot receive any balance.
   */
  async approveHolder(holderAddress: string): Promise<TxResponse> {
    assertValidHolderAddress(holderAddress)
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuer.classicAddress,
      MPTokenIssuanceID: this.id,
      Holder: holderAddress,
    }
    return submitAndVerify(this.client, this.issuer, tx)
  }

  /**
   * Revokes a holder's allowlist authorization without touching their
   * balance. The holder keeps whatever they currently hold but cannot
   * receive more. Prefer {@link banHolder} to fully ban an address.
   */
  async revokeHolderAuthorization(holderAddress: string): Promise<TxResponse> {
    assertValidHolderAddress(holderAddress)
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuer.classicAddress,
      MPTokenIssuanceID: this.id,
      Holder: holderAddress,
      Flags: { tfMPTUnauthorize: true },
    }
    return submitAndVerify(this.client, this.issuer, tx)
  }

  /**
   * Claws back an exact amount from a holder's balance.
   *
   * @param value - Amount to claw back, as a non-negative integer string in
   *   the issuance's base units.
   */
  async clawback(holderAddress: string, value: string): Promise<TxResponse> {
    assertValidHolderAddress(holderAddress)
    assertNonNegativeIntegerAmount(value)
    const tx: Clawback = {
      TransactionType: 'Clawback',
      Account: this.issuer.classicAddress,
      Holder: holderAddress,
      Amount: {
        mpt_issuance_id: this.id,
        value,
      },
    }
    return submitAndVerify(this.client, this.issuer, tx)
  }

  /**
   * Bans an address: claws back its entire balance (if any) and revokes
   * its allowlist authorization, so it ends up holding none of the token
   * and cannot receive it again (RequireAuth means an unauthorized address
   * cannot receive a payment, from the issuer or anyone else).
   *
   * Safe to call on a holder with a zero balance or who never opted in.
   */
  async banHolder(holderAddress: string): Promise<void> {
    assertValidHolderAddress(holderAddress)
    const state = await this.getHolderState(holderAddress)

    if (!state.exists) {
      // Nothing to claw back or revoke; there is no MPToken object to ban.
      return
    }

    if (state.balance !== '0') {
      await this.clawback(holderAddress, state.balance)
    }

    if (state.authorized) {
      await this.revokeHolderAuthorization(holderAddress)
    }
  }

  /** Freezes a single holder: they can neither send nor receive the token. */
  async freezeHolder(holderAddress: string): Promise<TxResponse> {
    assertValidHolderAddress(holderAddress)
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuer.classicAddress,
      MPTokenIssuanceID: this.id,
      Holder: holderAddress,
      Flags: { tfMPTLock: true },
    }
    return submitAndVerify(this.client, this.issuer, tx)
  }

  /** Lifts an individual freeze on a holder. */
  async unfreezeHolder(holderAddress: string): Promise<TxResponse> {
    assertValidHolderAddress(holderAddress)
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuer.classicAddress,
      MPTokenIssuanceID: this.id,
      Holder: holderAddress,
      Flags: { tfMPTUnlock: true },
    }
    return submitAndVerify(this.client, this.issuer, tx)
  }

  /** Freezes all movement of the token, for every holder, at once. */
  async globalFreeze(): Promise<TxResponse> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuer.classicAddress,
      MPTokenIssuanceID: this.id,
      Flags: { tfMPTLock: true },
    }
    return submitAndVerify(this.client, this.issuer, tx)
  }

  /** Lifts a global freeze. */
  async globalUnfreeze(): Promise<TxResponse> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuer.classicAddress,
      MPTokenIssuanceID: this.id,
      Flags: { tfMPTUnlock: true },
    }
    return submitAndVerify(this.client, this.issuer, tx)
  }

  /**
   * Issues (mints) tokens from the issuer to an allowlisted holder.
   *
   * Checks global freeze and the destination's authorization/freeze state
   * first and refuses locally (see the class-level doc comment for why);
   * the network's own checks are a second line of defense, not the first.
   *
   * @param value - Amount to send, as a non-negative integer string in the
   *   issuance's base units.
   */
  async send(destination: string, value: string): Promise<TxResponse> {
    assertValidHolderAddress(destination)
    assertNonNegativeIntegerAmount(value)

    const [issuanceState, holderState] = await Promise.all([
      this.getIssuanceState(),
      this.getHolderState(destination),
    ])
    if (issuanceState.globalLocked) {
      throw new ComplianceViolationError(
        `Cannot send: issuance ${this.id} is globally frozen.`,
      )
    }
    if (!holderState.authorized) {
      throw new ComplianceViolationError(
        `Cannot send to ${destination}: holder is not on the allowlist (never approved, or banned).`,
      )
    }
    if (holderState.locked) {
      throw new ComplianceViolationError(`Cannot send to ${destination}: holder is frozen.`)
    }

    const tx: Payment = {
      TransactionType: 'Payment',
      Account: this.issuer.classicAddress,
      Destination: destination,
      Amount: {
        mpt_issuance_id: this.id,
        value,
      },
    }
    return submitAndVerify(this.client, this.issuer, tx)
  }

  /** Reads a holder's current authorization, freeze, and balance state. */
  async getHolderState(holderAddress: string): Promise<HolderState> {
    assertValidHolderAddress(holderAddress)
    try {
      const response = await this.client.request({
        command: 'ledger_entry',
        mptoken: {
          mpt_issuance_id: this.id,
          account: holderAddress,
        },
      })
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- ledger_entry is untyped by mptoken shape
      const node = response.result.node as {
        MPTAmount?: string
        Flags: number
      }
      return {
        exists: true,
        authorized: hasFlag(node.Flags, MPTOKEN_FLAGS.lsfMPTAuthorized),
        locked: hasFlag(node.Flags, MPTOKEN_FLAGS.lsfMPTLocked),
        balance: node.MPTAmount ?? '0',
      }
    } catch (error) {
      if (isEntryNotFoundError(error)) {
        return NON_EXISTENT_HOLDER_STATE
      }
      throw error
    }
  }

  /** Reads the issuance's global freeze state, flags, and outstanding supply. */
  async getIssuanceState(): Promise<IssuanceState> {
    const response = await this.client.request({
      command: 'ledger_entry',
      mpt_issuance: this.id,
    })
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- ledger_entry is untyped by mpt_issuance shape
    const node = response.result.node as {
      Flags: number
      OutstandingAmount?: string
    }
    return {
      globalLocked: hasFlag(node.Flags, MPT_ISSUANCE_FLAGS.lsfMPTLocked),
      outstandingAmount: node.OutstandingAmount ?? '0',
      flags: {
        canLock: hasFlag(node.Flags, MPT_ISSUANCE_FLAGS.lsfMPTCanLock),
        requireAuth: hasFlag(node.Flags, MPT_ISSUANCE_FLAGS.lsfMPTRequireAuth),
        canTransfer: hasFlag(node.Flags, MPT_ISSUANCE_FLAGS.lsfMPTCanTransfer),
        canClawback: hasFlag(node.Flags, MPT_ISSUANCE_FLAGS.lsfMPTCanClawback),
      },
    }
  }
}

function isEntryNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const data = (error as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) {
    return false
  }
  return (data as { error?: unknown }).error === 'entryNotFound'
}
