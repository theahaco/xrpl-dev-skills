/**
 * Error types raised by the issuer module.
 *
 * Callers should branch on `code`, not on message text. Every error thrown
 * *before* submission (a `ComplianceError` or `InvalidInputError`) guarantees
 * that nothing was sent to the ledger.
 */

export type ComplianceErrorCode =
  | 'HOLDER_BANNED'
  | 'HOLDER_NOT_OPTED_IN'
  | 'HOLDER_NOT_AUTHORIZED'
  | 'HOLDER_FROZEN'
  | 'GLOBALLY_FROZEN'
  | 'INSUFFICIENT_HOLDER_BALANCE'
  | 'NOTHING_TO_CLAW_BACK'
  | 'ISSUER_IS_HOLDER'
  | 'ISSUANCE_NOT_FOUND'
  | 'ISSUANCE_MISCONFIGURED'
  | 'WRONG_NETWORK'
  | 'POSTCONDITION_FAILED'

/** A request was refused because it would violate a compliance rule or the issuance's configuration. */
export class ComplianceError extends Error {
  override readonly name = 'ComplianceError'

  constructor(
    readonly code: ComplianceErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Caller supplied a malformed argument (bad address, bad amount, ...). */
export class InvalidInputError extends Error {
  override readonly name = 'InvalidInputError'
}

/**
 * The ledger rejected or did not confirm a transaction.
 *
 * `engineResult` is the XRPL result code (e.g. `tecLOCKED`) when known. If
 * `hash` is set the transaction was signed and may have been submitted:
 * reconcile against the ledger before retrying.
 */
export class TransactionFailedError extends Error {
  override readonly name = 'TransactionFailedError'

  constructor(
    message: string,
    readonly transactionType: string,
    readonly engineResult: string | undefined,
    readonly hash: string | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
