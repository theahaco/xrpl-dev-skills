/** Base class for every error thrown by this package. */
export class MptIssuerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Invalid input supplied by the caller (bad address, amount, ...). Nothing was submitted. */
export class ValidationError extends MptIssuerError {}

/**
 * A compliance rule refused the operation before anything was submitted to the
 * ledger, e.g. approving a banned address or clawing back more than a holder owns.
 */
export class ComplianceError extends MptIssuerError {}

/**
 * The transaction reached a final, validated outcome other than `tesSUCCESS`
 * (a `tec` code), or was rejected outright (`tem`/`tef`/`tel`). Either way it
 * is definitively NOT applied, except that a `tec` result still consumed the fee.
 */
export class TransactionFailedError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly resultCode: string,
    readonly hash: string | undefined,
    message?: string,
  ) {
    super(message ?? `${transactionType} failed with ${resultCode}${hash ? ` (tx ${hash})` : ''}`)
  }
}

/**
 * The outcome of a submitted transaction could not be determined (e.g. the
 * connection dropped and the ledger history needed to prove the transaction was
 * never included is unavailable). The transaction MAY have been applied: look up
 * `hash` before retrying, otherwise you risk applying the operation twice.
 */
export class TransactionOutcomeUnknownError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    readonly lastLedgerSequence: number,
    options?: { cause?: unknown },
  ) {
    super(
      `Outcome of ${transactionType} ${hash} is unknown; it may still be applied up to ledger ${lastLedgerSequence}. ` +
        'Check the transaction hash before retrying.',
      options,
    )
  }
}
