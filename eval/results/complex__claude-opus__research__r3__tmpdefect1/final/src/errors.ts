/** Base class for every error raised by this module. */
export class IssuerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/**
 * A compliance rule stopped the operation before anything was submitted to
 * the ledger (for example: trying to authorize or pay a banned address).
 */
export class ComplianceError extends IssuerError {}

/** The operation's preconditions on ledger are not met (e.g. the holder has not opted in). */
export class PreconditionError extends IssuerError {}

/**
 * The transaction was submitted and reached a final, validated outcome other
 * than tesSUCCESS. The ledger state is known: the transaction did not apply
 * (apart from the fee for tec codes).
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
 * The transaction was signed (and possibly submitted) but its final outcome
 * could not be determined, e.g. because the connection dropped. Callers must
 * reconcile by looking up `hash` before retrying, or they risk applying the
 * action twice.
 */
export class TransactionOutcomeUnknownError extends IssuerError {
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    cause: unknown,
  ) {
    super(`Outcome of ${transactionType} (tx ${hash}) is unknown; reconcile before retrying`, { cause })
  }
}

/** Ledger state after an action did not match what the action should have produced. */
export class VerificationError extends IssuerError {}
