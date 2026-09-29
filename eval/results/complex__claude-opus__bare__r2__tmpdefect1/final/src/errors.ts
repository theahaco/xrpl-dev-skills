/**
 * Error hierarchy for the issuer module.
 *
 * Callers should branch on the class (and `reason` / `engineResult`) rather than on messages:
 *  - InvalidInputError       the request itself is malformed; nothing was submitted.
 *  - ComplianceError         a compliance rule refused the request; nothing was submitted.
 *  - IssuanceConfigError     the on-ledger issuance does not have the controls we require.
 *  - TransactionFailedError  the transaction definitively did NOT take effect: a tec* result
 *                            in a validated ledger, tem* at submission, or EXPIRED (in no
 *                            ledger up to its LastLedgerSequence).
 *  - OutcomeUnknownError     we could not determine whether the transaction was applied.
 *                            Do NOT blindly retry; look the hash up first.
 */
export class MptIssuerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

export class InvalidInputError extends MptIssuerError {}

export type ComplianceReason =
  | 'HOLDER_BANNED'
  | 'HOLDER_NOT_OPTED_IN'
  | 'HOLDER_NOT_AUTHORIZED'
  | 'HOLDER_FROZEN'
  | 'GLOBALLY_FROZEN'
  | 'INSUFFICIENT_BALANCE'

export class ComplianceError extends MptIssuerError {
  constructor(
    readonly reason: ComplianceReason,
    readonly holder: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

export class IssuanceConfigError extends MptIssuerError {
  constructor(
    readonly issuanceId: string,
    readonly problems: readonly string[],
  ) {
    super(`MPT issuance ${issuanceId} is not safe to operate: ${problems.join('; ')}`)
  }
}

export class TransactionFailedError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    /** Engine result code, e.g. "tecNO_AUTH", or "EXPIRED" if it never made it into a ledger. */
    readonly engineResult: string,
    detail?: string,
  ) {
    super(
      `${transactionType} ${hash} failed with ${engineResult}${detail !== undefined ? `: ${detail}` : ''}`,
    )
  }
}

export class OutcomeUnknownError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    readonly lastLedgerSequence: number,
    options?: ErrorOptions,
  ) {
    super(
      `Could not confirm the outcome of ${transactionType} ${hash} ` +
        `(LastLedgerSequence ${lastLedgerSequence}). Look the hash up before retrying.`,
      options,
    )
  }
}
