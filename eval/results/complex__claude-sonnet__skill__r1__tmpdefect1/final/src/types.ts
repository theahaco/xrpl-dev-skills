/**
 * Shared types for the MPT compliance issuer module.
 */

/** Options for creating a new MPT issuance. */
export interface IssuanceConfig {
  /**
   * Decimal places for display purposes. `0` means whole-unit amounts
   * (e.g. "500" means 500 tokens). Defaults to `0`.
   */
  assetScale?: number
  /**
   * Maximum number of units that may ever be outstanding. Defaults to the
   * protocol maximum (2^63 - 1).
   */
  maximumAmount?: string
  /**
   * Secondary-sale transfer fee in tenths of a basis point (0-50000).
   * Requires holder-to-holder transfers to be enabled.
   */
  transferFee?: number
  /** Hex-encoded MPT metadata blob (XLS-89 format). */
  metadataHex?: string
  /**
   * Allow tokens to move directly between two non-issuer holders. Defaults
   * to `true`. A regulated issuer that wants every movement to route back
   * through it can set this to `false`.
   */
  allowHolderToHolderTransfer?: boolean
}

/** Point-in-time state of a single holder's relationship to the issuance. */
export interface HolderState {
  /** Whether the holder has an MPToken object at all (has opted in). */
  exists: boolean
  /** Whether the issuer has authorized this holder (allowlist). */
  authorized: boolean
  /** Whether this holder is individually frozen. */
  locked: boolean
  /** Current balance, in the issuance's base units, as a decimal string. */
  balance: string
}

/** A holder with no MPToken object at all is implicitly not authorized. */
export const NON_EXISTENT_HOLDER_STATE: HolderState = {
  exists: false,
  authorized: false,
  locked: false,
  balance: '0',
}

/** Point-in-time state of the issuance itself. */
export interface IssuanceState {
  /** Whether the whole token is globally frozen. */
  globalLocked: boolean
  /** Total units currently held by non-issuer accounts. */
  outstandingAmount: string
  flags: {
    canLock: boolean
    requireAuth: boolean
    canTransfer: boolean
    canClawback: boolean
  }
}
