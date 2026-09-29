/**
 * Base class for every error thrown by this module, so callers can
 * distinguish our failures from unrelated exceptions with one `instanceof`.
 */
export class MptIssuerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/**
 * A compliance rule refused the operation before anything was submitted to
 * the ledger (for example: paying a banned, unapproved or frozen holder).
 */
export class ComplianceError extends MptIssuerError {}

/** Caller supplied an invalid argument (bad address, malformed amount, ...). */
export class InvalidArgumentError extends MptIssuerError {}

/**
 * The MPT issuance on the ledger does not have the configuration this module
 * depends on (wrong issuer, missing Require Auth / Can Lock / Can Clawback,
 * or a capability enabled that would let tokens escape the controls).
 */
export class IssuanceConfigError extends MptIssuerError {}

/**
 * The transaction reached a final, validated outcome other than tesSUCCESS.
 * `tec` codes are included in a validated ledger and consume the fee;
 * `tem`/`tef` codes are rejected before inclusion.
 */
export class TransactionFailedError extends MptIssuerError {
  readonly resultCode: string
  readonly hash: string
  readonly ledgerIndex: number | undefined

  constructor(transactionType: string, resultCode: string, hash: string, ledgerIndex?: number) {
    super(
      `${transactionType} ${hash} failed with ${resultCode}` +
        (ledgerIndex === undefined ? '' : ` (validated in ledger ${ledgerIndex})`),
    )
    this.resultCode = resultCode
    this.hash = hash
    this.ledgerIndex = ledgerIndex
  }
}

/**
 * The transaction's LastLedgerSequence passed without it being validated, and
 * the server confirmed it searched the full ledger range. The transaction can
 * never be applied, so it is safe to build and submit a new one.
 */
export class TransactionExpiredError extends MptIssuerError {
  readonly hash: string

  constructor(transactionType: string, hash: string, lastLedgerSequence: number) {
    super(
      `${transactionType} ${hash} was not validated by LastLedgerSequence ${lastLedgerSequence}; it can no longer be applied`,
    )
    this.hash = hash
  }
}

/**
 * The final outcome of a submitted transaction could not be determined (for
 * example, the connection was lost and the server lacks the ledger history
 * needed to prove the transaction was not applied). The transaction may or may
 * not have been applied: look up `hash` before retrying, or you risk
 * applying the operation twice.
 */
export class TransactionOutcomeUnknownError extends MptIssuerError {
  readonly hash: string

  constructor(transactionType: string, hash: string, cause?: unknown) {
    super(
      `Outcome of ${transactionType} ${hash} is unknown; look it up by hash before retrying`,
      cause === undefined ? undefined : { cause },
    )
    this.hash = hash
  }
}
