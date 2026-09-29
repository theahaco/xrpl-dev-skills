/** Base class for every error raised by this module. */
export class IssuerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Input failed validation before anything was sent to the ledger. */
export class InvalidInputError extends IssuerError {}

/**
 * A compliance rule stopped the operation before anything was submitted.
 * Nothing was sent to the ledger.
 */
export class ComplianceViolationError extends IssuerError {
  constructor(
    readonly code:
      | 'HOLDER_BANNED'
      | 'HOLDER_NOT_AUTHORIZED'
      | 'HOLDER_NOT_OPTED_IN'
      | 'HOLDER_FROZEN'
      | 'GLOBALLY_FROZEN'
      | 'INSUFFICIENT_BALANCE'
      | 'MAXIMUM_AMOUNT_EXCEEDED',
    message: string,
  ) {
    super(message)
  }
}

/**
 * The transaction was validated in a ledger but did not succeed. Its result
 * code starts with `tec`, the fee was charged, and nothing else changed.
 */
export class TransactionFailedError extends IssuerError {
  constructor(
    readonly transactionType: string,
    readonly resultCode: string,
    readonly hash: string,
  ) {
    super(`${transactionType} failed with ${resultCode} (tx ${hash})`)
  }
}

/**
 * The transaction could not be confirmed. It may or may not have been applied.
 * Before retrying, look up `hash`, or wait until the ledger passes
 * `lastLedgerSequence`.
 */
export class TransactionOutcomeUnknownError extends IssuerError {
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    readonly lastLedgerSequence: number | undefined,
    cause: unknown,
  ) {
    super(`Outcome of ${transactionType} ${hash} is unknown: ${String(cause)}`, { cause })
  }
}

/**
 * A compliance action finished only part of its steps. The steps that did
 * finish are durable. Re-running the same action is safe and finishes the rest.
 */
export class IncompleteActionError extends IssuerError {}

/** The client is connected to a different network than the one configured. */
export class NetworkMismatchError extends IssuerError {}

/**
 * The transaction was definitely not applied: the server rejected it
 * (`tem`/`tef`), or it expired before being validated. Retrying is safe.
 */
export class TransactionNotAppliedError extends IssuerError {
  constructor(
    readonly transactionType: string,
    readonly resultCode: string,
    readonly hash: string,
    detail: string,
  ) {
    super(`${transactionType} was not applied (${resultCode}): ${detail} (tx ${hash})`)
  }
}
