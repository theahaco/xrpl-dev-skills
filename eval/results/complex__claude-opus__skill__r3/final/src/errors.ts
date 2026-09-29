/**
 * Error hierarchy for the MPT issuer module.
 *
 * Callers should distinguish three classes of transaction outcome, because they
 * have very different operational consequences:
 *
 *  - {@link TransactionNotAppliedError}: the transaction is definitively NOT in
 *    the ledger and never will be. Safe to retry.
 *  - {@link TransactionFailedError}: the transaction IS in a validated ledger but
 *    failed (a `tec` code). It consumed a fee and a sequence number, but changed
 *    nothing else. Retrying needs a decision, because the failure is usually a
 *    business-rule rejection.
 *  - {@link TransactionOutcomeUnknownError}: we could not determine the outcome
 *    (for example, the connection was lost). Do NOT blindly retry. Reconcile
 *    using the transaction hash first.
 *
 * {@link ComplianceError} subclasses are raised by pre-flight checks, before
 * anything is signed or submitted.
 */

export class MptIssuerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Caller supplied an invalid argument (bad address, malformed amount, ...). */
export class InvalidInputError extends MptIssuerError {}

/** The issuance on ledger does not match what this module requires. */
export class IssuanceConfigurationError extends MptIssuerError {}

/** Base class for pre-flight compliance rejections. Nothing was submitted. */
export class ComplianceError extends MptIssuerError {
  constructor(
    message: string,
    readonly holder?: string,
  ) {
    super(message);
  }
}

export class HolderBannedError extends ComplianceError {}
export class HolderNotOptedInError extends ComplianceError {}
export class HolderNotAuthorizedError extends ComplianceError {}
export class HolderFrozenError extends ComplianceError {}
export class GlobalFreezeActiveError extends ComplianceError {}
export class InsufficientHolderBalanceError extends ComplianceError {}

/** Transaction definitively not included in the ledger (safe to retry). */
export class TransactionNotAppliedError extends MptIssuerError {
  constructor(
    message: string,
    readonly engineResult: string | undefined,
    readonly hash: string | undefined,
  ) {
    super(message);
  }
}

/** Transaction included in a validated ledger with a non-success result code. */
export class TransactionFailedError extends MptIssuerError {
  constructor(
    readonly resultCode: string,
    readonly hash: string,
    readonly ledgerIndex: number,
    readonly transactionType: string,
  ) {
    super(`${transactionType} ${hash} failed in validated ledger ${ledgerIndex} with ${resultCode}`);
  }
}

/** Outcome could not be determined. Reconcile by hash before retrying. */
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

/** Post-condition check after a multi-step operation (for example, a ban) did not hold. */
export class InvariantViolationError extends MptIssuerError {}
