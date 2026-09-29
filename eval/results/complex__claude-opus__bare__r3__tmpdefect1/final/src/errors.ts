/** Base class for every error raised by this module. */
export class MptIssuerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Caller passed an invalid argument (bad address, amount, etc). Nothing was submitted. */
export class InvalidArgumentError extends MptIssuerError {}

/** The requested action is refused by policy (e.g. authorizing a banned address). Nothing was submitted. */
export class PolicyViolationError extends MptIssuerError {}

/**
 * A transaction reached a final outcome other than tesSUCCESS.
 *
 * `applied` is true when the transaction was included in a validated ledger
 * (a `tec` code: fee was charged, but no other changes were made). It is false
 * when the transaction was rejected before it could be applied (`tem`, `tef`,
 * `tel`) or expired without being included in a ledger. Either way, the
 * intended state change did NOT happen.
 */
export class TransactionFailedError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly resultCode: string,
    readonly hash: string,
    readonly applied: boolean,
    message?: string,
  ) {
    super(message ?? `${transactionType} ${hash} failed with ${resultCode}`)
  }
}

/**
 * We could not determine whether a transaction was applied (e.g. the
 * connection was lost and the outcome could not be looked up before the
 * timeout). The caller MUST reconcile by looking up `hash` before retrying,
 * otherwise the action may be applied twice.
 */
export class SubmissionOutcomeUnknownError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    readonly lastLedgerSequence: number,
    options?: ErrorOptions,
  ) {
    super(
      `Outcome of ${transactionType} ${hash} is unknown (LastLedgerSequence ${lastLedgerSequence}); ` +
        'look the hash up before retrying',
      options,
    )
  }
}

/** The ledger is not in the state required for the action (e.g. holder has not opted in). */
export class LedgerStateError extends MptIssuerError {}
