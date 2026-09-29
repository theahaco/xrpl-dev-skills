import type { MPTokenMetadata } from "xrpl";

export interface IssuanceParams {
  /** Decimal places for display purposes. Default 2 (cent-level precision). */
  assetScale?: number;
  /** Hard cap on total outstanding units, as a string integer. */
  maximumAmount?: string;
  /** Transfer fee in basis points of 1% (max 50000 = 50%). Default 0. */
  transferFee?: number;
  /** XLS-89 token metadata (name, ticker, icon, etc.), hex-encoded onto MPTokenMetadata. */
  metadata?: MPTokenMetadata;
}

export interface IssuanceCreateResult {
  issuanceId: string;
  hash: string;
}

export interface SubmittedTx {
  hash: string;
  ledgerIndex?: number;
}

export interface HolderState {
  address: string;
  /** Whether the holder has an MPToken object at all (i.e. has opted in). */
  exists: boolean;
  /** Current balance, as a string integer in the issuance's base units. */
  balance: string;
  /** Whether the issuer has approved this holder under RequireAuth (the allowlist). */
  authorized: boolean;
  /** Whether this specific holder is frozen (locked). */
  frozen: boolean;
}

export interface IssuanceState {
  issuanceId: string;
  issuer: string;
  outstandingAmount: string;
  maximumAmount?: string;
  assetScale?: number;
  /** RequireAuth is on, i.e. the allowlist is enforced. */
  requireAuth: boolean;
  /** Clawback is enabled for this issuance. */
  canClawback: boolean;
  /** Locking (freeze) is enabled for this issuance. */
  canLock: boolean;
  /** Transfers between two non-issuer holders are enabled. */
  canTransfer: boolean;
  /** Whether the whole issuance is currently globally frozen. */
  globallyLocked: boolean;
}
