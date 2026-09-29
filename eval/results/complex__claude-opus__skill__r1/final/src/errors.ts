/** Base class for every error raised by this module. */
export class MptIssuerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Input rejected before anything was sent to the ledger. */
export class ValidationError extends MptIssuerError {}

/** A compliance rule (e.g. the ban list) prevented the operation. Nothing was sent to the ledger. */
export class ComplianceError extends MptIssuerError {}

/**
 * The transaction reached a final, validated outcome that was not `tesSUCCESS`
 * (a `tec` code, which consumes the fee), or was rejected outright as malformed (`tem`).
 */
export class TransactionFailedError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly resultCode: string,
    readonly hash: string,
    readonly ledgerIndex?: number,
  ) {
    super(`${transactionType} ${hash} failed with ${resultCode}`);
  }
}

/**
 * The transaction's LastLedgerSequence has passed and a complete ledger search
 * confirmed it was never included. It can never succeed and is safe to re-attempt.
 */
export class TransactionExpiredError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    readonly preliminaryResult: string,
  ) {
    super(`${transactionType} ${hash} expired without being validated (preliminary result ${preliminaryResult})`);
  }
}

/**
 * The outcome of a submitted transaction could not be determined (connection loss,
 * server missing ledger history, timeout). It MAY have been applied. Callers must
 * reconcile by looking up `hash` before retrying, or they risk applying an operation twice.
 */
export class TransactionOutcomeUnknownError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`Outcome of ${transactionType} ${hash} is unknown: ${reason}`, options);
  }
}

/** A post-condition check against the validated ledger did not hold. */
export class InvariantError extends MptIssuerError {}
