/** Base class for every error raised by this package. */
export class IssuerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Invalid input from the caller (bad address, malformed amount, ...). */
export class ValidationError extends IssuerError {}

/**
 * A compliance rule forbids the requested action, e.g. approving a banned
 * address or issuing to a frozen holder. Nothing was submitted to the ledger.
 */
export class ComplianceViolationError extends IssuerError {}

/** The on-ledger state does not match what the module requires. */
export class LedgerStateError extends IssuerError {}

/**
 * A transaction was validated by the network with a non-success result
 * (a `tec` code). The fee was spent, but the transaction had no other effect.
 */
export class TransactionFailedError extends IssuerError {
  constructor(
    readonly transactionType: string,
    readonly resultCode: string,
    readonly hash: string,
  ) {
    super(`${transactionType} failed on ledger with ${resultCode} (tx ${hash})`)
  }
}

/**
 * The outcome of a transaction could not be determined (e.g. the connection
 * dropped and the transaction had not expired yet). The transaction MAY still
 * be validated later; reconcile using `hash` before retrying.
 */
export class TransactionOutcomeUnknownError extends IssuerError {
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    readonly lastLedgerSequence: number | undefined,
    options?: ErrorOptions,
  ) {
    super(
      `Outcome of ${transactionType} ${hash} is unknown (LastLedgerSequence ${lastLedgerSequence ?? 'unset'}); check the hash before retrying`,
      options,
    )
  }
}
