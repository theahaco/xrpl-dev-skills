/**
 * A transaction reached the ledger (or was rejected by it) with a result other
 * than `tesSUCCESS`. `engineResult` is the rippled result code, e.g. `tecNO_AUTH`.
 */
export class XrplTransactionError extends Error {
  override readonly name = 'XrplTransactionError'

  constructor(
    readonly transactionType: string,
    readonly engineResult: string,
    readonly hash: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(
      `${transactionType} failed with ${engineResult}${hash ? ` (tx ${hash})` : ''}`,
      options,
    )
  }
}

/**
 * The issuer module refused to perform an action because it would violate a
 * compliance rule (e.g. paying a banned or frozen holder). Nothing was submitted.
 */
export class ComplianceViolationError extends Error {
  override readonly name = 'ComplianceViolationError'

  constructor(
    readonly code: ComplianceViolationCode,
    message: string,
  ) {
    super(message)
  }
}

export type ComplianceViolationCode =
  | 'HOLDER_BANNED'
  | 'HOLDER_NOT_OPTED_IN'
  | 'HOLDER_NOT_AUTHORIZED'
  | 'HOLDER_FROZEN'
  | 'GLOBALLY_FROZEN'
  | 'HOLDER_HAS_BALANCE'
  | 'INVALID_ADDRESS'
  | 'INVALID_AMOUNT'
  | 'ISSUER_AS_HOLDER'

/** The issuance on the ledger doesn't match what this module requires. */
export class IssuanceConfigurationError extends Error {
  override readonly name = 'IssuanceConfigurationError'
}

/** After a transaction succeeded, the resulting ledger state wasn't what we expected. */
export class PostConditionError extends Error {
  override readonly name = 'PostConditionError'
}
