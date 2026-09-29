import {
  fetchMPToken,
  fetchMPTokenIssuance,
  parseMPTokenIssuanceFlags,
  type Clawback,
  type Client,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type MPTokenIssuanceSet,
  type Payment,
  type Wallet,
} from 'xrpl'

import { fromBaseUnits, toBaseUnits } from './amounts.js'
import { submitAndVerify } from './txHelpers.js'

/**
 * The MPToken ledger object (per-holder) encodes these as bit flags on its
 * `Flags` field. The `xrpl` package does not export an enum for them (unlike
 * the issuance-level flags), so they are declared here per the MPToken
 * ledger entry reference: https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken
 */
const MPTOKEN_LOCKED_FLAG = 0x00000001
const MPTOKEN_AUTHORIZED_FLAG = 0x00000002

export interface CreateIssuanceParams {
  /** Number of decimal places used to display amounts. Base units = human units * 10^assetScale. */
  assetScale: number
  /** Maximum amount that may ever be outstanding, in human-readable units. Defaults to the protocol max. */
  maximumAmount?: string
  /** Secondary-sale transfer fee, 0-50000 (0.001% increments). Requires holder-to-holder transfers to be allowed. */
  transferFeeBasisPoints?: number
  /** Allow holders to transfer to each other (not just to/from the issuer). Defaults to true. */
  allowTransferBetweenHolders?: boolean
  /** Pre-encoded (hex) MPTokenMetadata blob, e.g. from `encodeMPTokenMetadata`. */
  metadataHex?: string
}

export interface HolderState {
  /** Balance in human-readable units. */
  balance: string
  /** Whether the issuer has authorized this holder (relevant when the issuance requires auth). */
  authorized: boolean
  /** Whether this holder's balance is individually locked. */
  locked: boolean
}

export interface IssuanceState {
  issuanceId: string
  /** Total amount in circulation, in human-readable units. */
  outstandingAmount: string
  /** Whether the whole issuance is globally locked. */
  globallyLocked: boolean
  canLock: boolean
  requireAuth: boolean
  canClawback: boolean
  canTransfer: boolean
}

/**
 * Issuer-side control surface for a single regulated MPT issuance.
 *
 * One instance is bound to one issuer account and (after `createIssuance` or
 * `attachIssuance`) one MPTokenIssuanceID. All mutating methods sign with the
 * issuer wallet, submit, wait for ledger validation, and verify the result --
 * they throw `TransactionFailedError` (see txHelpers.ts) on any non-success
 * engine result so callers never silently proceed on a failed control action.
 */
export class MptIssuer {
  private _issuanceId: string | undefined
  private _assetScale: number | undefined

  constructor(
    private readonly client: Client,
    private readonly issuerWallet: Wallet,
  ) {}

  get address(): string {
    return this.issuerWallet.address
  }

  get issuanceId(): string {
    if (this._issuanceId === undefined) {
      throw new Error('No MPT issuance attached. Call createIssuance() or attachIssuance() first.')
    }
    return this._issuanceId
  }

  get assetScale(): number {
    if (this._assetScale === undefined) {
      throw new Error('No MPT issuance attached. Call createIssuance() or attachIssuance() first.')
    }
    return this._assetScale
  }

  /** Binds this instance to an MPT issuance that already exists on the ledger. */
  attachIssuance(issuanceId: string, assetScale: number): void {
    this._issuanceId = issuanceId
    this._assetScale = assetScale
  }

  /**
   * Creates a new MPT issuance with every compliance control enabled:
   * lockable (per-holder freeze + global freeze), require-auth (allowlist),
   * and clawback. Returns the new MPTokenIssuanceID.
   */
  async createIssuance(params: CreateIssuanceParams): Promise<string> {
    const allowTransfer = params.allowTransferBetweenHolders ?? true

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: this.issuerWallet.address,
      AssetScale: params.assetScale,
      Flags: {
        tfMPTCanLock: true,
        tfMPTRequireAuth: true,
        tfMPTCanClawback: true,
        tfMPTCanTransfer: allowTransfer,
      },
      ...(params.maximumAmount !== undefined && {
        MaximumAmount: toBaseUnits(params.maximumAmount, params.assetScale),
      }),
      ...(params.transferFeeBasisPoints !== undefined && {
        TransferFee: params.transferFeeBasisPoints,
      }),
      ...(params.metadataHex !== undefined && { MPTokenMetadata: params.metadataHex }),
    }

    const response = await submitAndVerify(this.client, this.issuerWallet, tx)
    const meta = response.result.meta
    const issuanceId = typeof meta === 'object' && meta !== null ? meta.mpt_issuance_id : undefined

    if (!issuanceId) {
      throw new Error('MPTokenIssuanceCreate succeeded but the ledger did not return an mpt_issuance_id')
    }

    this._issuanceId = issuanceId
    this._assetScale = params.assetScale
    return issuanceId
  }

  /**
   * Allowlists a holder. The holder must have already opted in (submitted its
   * own MPTokenAuthorize with no Holder field), which creates their
   * unauthorized MPToken object.
   */
  async approveHolder(holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
    }
    await submitAndVerify(this.client, this.issuerWallet, tx)
  }

  /**
   * Revokes a holder's allowlist authorization. Because the issuance requires
   * auth, an unauthorized holder cannot receive the token again until
   * re-approved -- this does not touch their existing balance or lock state.
   */
  async revokeHolderAuthorization(holderAddress: string): Promise<void> {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
      Flags: { tfMPTUnauthorize: true },
    }
    await submitAndVerify(this.client, this.issuerWallet, tx)
  }

  /** Issues (or transfers, if called by a holder) tokens. Amount is in human-readable units. */
  async sendTokens(destination: string, humanAmount: string): Promise<void> {
    const tx: Payment = {
      TransactionType: 'Payment',
      Account: this.issuerWallet.address,
      Destination: destination,
      Amount: {
        mpt_issuance_id: this.issuanceId,
        value: toBaseUnits(humanAmount, this.assetScale),
      },
    }
    await submitAndVerify(this.client, this.issuerWallet, tx)
  }

  /** Claws back a specific amount (human-readable units) from a holder. */
  async clawback(holderAddress: string, humanAmount: string): Promise<void> {
    const tx: Clawback = {
      TransactionType: 'Clawback',
      Account: this.issuerWallet.address,
      Holder: holderAddress,
      Amount: {
        mpt_issuance_id: this.issuanceId,
        value: toBaseUnits(humanAmount, this.assetScale),
      },
    }
    await submitAndVerify(this.client, this.issuerWallet, tx)
  }

  /** Claws back a holder's entire current balance. Returns the amount clawed back (human-readable units). Idempotent no-op if already zero. */
  async clawbackAll(holderAddress: string): Promise<string> {
    const state = await this.getHolderState(holderAddress)
    if (state === null || state.balance === '0') {
      return '0'
    }
    await this.clawback(holderAddress, state.balance)
    return state.balance
  }

  /** Freezes a single holder: they can neither send nor receive the token until unfrozen. */
  async freezeHolder(holderAddress: string): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
      Flags: { tfMPTLock: true },
    }
    await submitAndVerify(this.client, this.issuerWallet, tx)
  }

  /** Lifts an individual holder freeze. */
  async unfreezeHolder(holderAddress: string): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holderAddress,
      Flags: { tfMPTUnlock: true },
    }
    await submitAndVerify(this.client, this.issuerWallet, tx)
  }

  /** Locks movement of the token for every holder (e.g. during an incident). */
  async globalFreeze(): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Flags: { tfMPTLock: true },
    }
    await submitAndVerify(this.client, this.issuerWallet, tx)
  }

  /** Lifts the global freeze. */
  async globalUnfreeze(): Promise<void> {
    const tx: MPTokenIssuanceSet = {
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerWallet.address,
      MPTokenIssuanceID: this.issuanceId,
      Flags: { tfMPTUnlock: true },
    }
    await submitAndVerify(this.client, this.issuerWallet, tx)
  }

  /**
   * Permanently bans a holder: claws back their entire balance, locks their
   * MPToken so any balance they might otherwise obtain is frozen, and revokes
   * their allowlist authorization so they cannot be paid again. After this
   * call the holder is guaranteed to hold zero tokens and cannot receive more.
   */
  async banHolder(holderAddress: string): Promise<{ clawedBack: string }> {
    const clawedBack = await this.clawbackAll(holderAddress)
    await this.freezeHolder(holderAddress)
    await this.revokeHolderAuthorization(holderAddress)
    return { clawedBack }
  }

  /** Reads a holder's current balance, authorization, and lock state. Returns null if the holder has never opted in. */
  async getHolderState(holderAddress: string): Promise<HolderState | null> {
    try {
      const token = await fetchMPToken(this.client, holderAddress, this.issuanceId)
      // rippled omits MPTAmount/Flags from the ledger entry entirely when
      // they equal their default (zero) value, rather than reporting "0".
      const flags = token.Flags ?? 0
      return {
        balance: fromBaseUnits(token.MPTAmount ?? '0', this.assetScale),
        authorized: (flags & MPTOKEN_AUTHORIZED_FLAG) !== 0,
        locked: (flags & MPTOKEN_LOCKED_FLAG) !== 0,
      }
    } catch {
      return null
    }
  }

  /** Reads the issuance-wide state: outstanding supply, global lock, and enabled capabilities. */
  async getIssuanceState(): Promise<IssuanceState> {
    const issuance = await fetchMPTokenIssuance(this.client, this.issuanceId)
    const flags = parseMPTokenIssuanceFlags(issuance.Flags)

    return {
      issuanceId: this.issuanceId,
      outstandingAmount: fromBaseUnits(issuance.OutstandingAmount, this.assetScale),
      globallyLocked: flags.lsfMPTLocked ?? false,
      canLock: flags.lsfMPTCanLock ?? false,
      requireAuth: flags.lsfMPTRequireAuth ?? false,
      canClawback: flags.lsfMPTCanClawback ?? false,
      canTransfer: flags.lsfMPTCanTransfer ?? false,
    }
  }
}
