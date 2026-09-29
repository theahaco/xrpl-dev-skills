/**
 * Error types raised by the issuer module. Callers should branch on the class
 * (and on `engineResult` for ledger rejections) rather than on message text.
 */

/** Base class for every error thrown deliberately by this module. */
export class MptIssuerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Input failed validation before anything was sent to the ledger. */
export class ValidationError extends MptIssuerError {}

/**
 * A compliance rule in this module refused the operation before submission
 * (e.g. authorizing a banned address, issuing to a frozen holder).
 */
export class PolicyViolationError extends MptIssuerError {}

/** The issuance on ledger does not have the capabilities this module requires. */
export class IssuanceConfigError extends MptIssuerError {}

/**
 * The ledger definitively did not apply the transaction as intended, either
 * because it was rejected before inclusion (tem/tef/tel) or because it was
 * included in a validated ledger with a non-success (tec) result.
 */
export class TransactionFailedError extends MptIssuerError {
  constructor(
    message: string,
    readonly engineResult: string,
    readonly hash: string | undefined,
    readonly validated: boolean,
  ) {
    super(message);
  }
}

/**
 * The transaction was submitted but its final outcome could not be
 * determined (for example the connection dropped while waiting). The
 * transaction MAY have been applied: look up `hash` before retrying.
 */
export class TransactionOutcomeUnknownError extends MptIssuerError {
  constructor(
    message: string,
    readonly hash: string,
    readonly lastLedgerSequence: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Post-condition check after an operation found unexpected ledger state. */
export class InvariantViolationError extends MptIssuerError {}
