/**
 * Error types raised by the issuer module. Backends should branch on the class
 * (or `code`) rather than parsing messages.
 */

export class MptIssuerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Invalid input from the caller (bad address, bad amount, ...). Nothing was submitted. */
export class InvalidInputError extends MptIssuerError {}

/**
 * The module refused to perform an operation because it would violate a
 * compliance rule (e.g. issuing to a banned or frozen holder). Nothing was submitted.
 */
export class ComplianceViolationError extends MptIssuerError {
  constructor(
    message: string,
    readonly rule: 'banned' | 'holder-frozen' | 'globally-frozen' | 'not-approved',
    readonly holder?: string,
  ) {
    super(message)
  }
}

/** The holder has not created its MPToken entry (opted in), so the issuer cannot act on it yet. */
export class HolderNotOptedInError extends MptIssuerError {
  constructor(readonly holder: string) {
    super(`Holder ${holder} has not opted in to the token (no MPToken entry exists)`)
  }
}

/** The issuance on ledger does not match what this module requires. */
export class IssuanceMisconfiguredError extends MptIssuerError {}

/**
 * A transaction reached a final outcome on a validated ledger (or was
 * rejected outright) with a result other than tesSUCCESS.
 *
 * `code` is the XRPL engine result, e.g. `tecNO_AUTH`, `tecLOCKED`.
 * If `validated` is true the transaction is in a validated ledger (and paid
 * its fee) but had no other effect.
 */
export class TransactionFailedError extends MptIssuerError {
  constructor(
    readonly code: string,
    readonly hash: string,
    readonly transactionType: string,
    readonly validated: boolean,
    detail?: string,
  ) {
    super(
      `${transactionType} ${hash} failed with ${code}${validated ? ' (validated)' : ''}${detail ? `: ${detail}` : ''}`,
    )
  }
}

/**
 * The transaction's outcome could not be determined (e.g. the server lacks
 * the ledger history to prove it was never included). The caller MUST
 * reconcile by looking up `hash` before retrying, or it risks double-applying.
 */
export class TransactionOutcomeUnknownError extends MptIssuerError {
  constructor(
    readonly hash: string,
    readonly transactionType: string,
    detail: string,
  ) {
    super(`Outcome of ${transactionType} ${hash} is unknown: ${detail}`)
  }
}

/** A post-condition check after an operation did not hold (e.g. balance not zero after a ban). */
export class PostConditionError extends MptIssuerError {}
