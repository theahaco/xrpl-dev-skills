export type IssuerErrorCode =
  | 'INVALID_ADDRESS'
  | 'INVALID_AMOUNT'
  | 'HOLDER_BANNED'
  | 'HOLDER_NOT_OPTED_IN'
  | 'HOLDER_NOT_AUTHORIZED'
  | 'HOLDER_FROZEN'
  | 'TOKEN_FROZEN'
  | 'INSUFFICIENT_BALANCE'
  | 'ISSUANCE_NOT_FOUND'
  | 'ISSUANCE_MISCONFIGURED'
  | 'BAN_INCOMPLETE'
  | 'TX_FAILED'
  | 'TX_EXPIRED'

/** Base class for every error raised by this module. */
export class IssuerError extends Error {
  readonly code: IssuerErrorCode

  constructor(code: IssuerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'IssuerError'
    this.code = code
  }
}

/**
 * A transaction reached a final, validated outcome other than tesSUCCESS,
 * or was rejected outright and can never be applied.
 */
export class TransactionFailedError extends IssuerError {
  readonly hash: string
  readonly resultCode: string
  /** true if the transaction is in a validated ledger (fee was charged). */
  readonly validated: boolean

  constructor(txType: string, hash: string, resultCode: string, validated: boolean) {
    super('TX_FAILED', `${txType} ${hash} failed with ${resultCode}${validated ? ' (validated)' : ' (not applied)'}`)
    this.name = 'TransactionFailedError'
    this.hash = hash
    this.resultCode = resultCode
    this.validated = validated
  }
}

/** The transaction's LastLedgerSequence passed without it being included in a validated ledger. */
export class TransactionExpiredError extends IssuerError {
  readonly hash: string

  constructor(txType: string, hash: string, lastLedgerSequence: number) {
    super('TX_EXPIRED', `${txType} ${hash} was not validated by LastLedgerSequence ${lastLedgerSequence}; it can no longer be applied`)
    this.name = 'TransactionExpiredError'
    this.hash = hash
  }
}
