import type { TransactionMetadata } from 'xrpl';

/**
 * Raised when a compliance rule enforced by this module (not by the ledger)
 * refuses an operation, e.g. authorizing a banned address or issuing to a
 * frozen holder. Nothing is submitted to the ledger when this is thrown.
 */
export class ComplianceError extends Error {
  override readonly name = 'ComplianceError';

  constructor(
    readonly code: ComplianceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ComplianceErrorCode =
  | 'HOLDER_BANNED'
  | 'HOLDER_NOT_OPTED_IN'
  | 'HOLDER_NOT_AUTHORIZED'
  | 'HOLDER_FROZEN'
  | 'GLOBALLY_FROZEN'
  | 'NOTHING_TO_CLAW_BACK'
  | 'ESCROWED_BALANCE'
  | 'ISSUANCE_MISSING_CONTROLS'
  | 'NOT_ISSUER'
  | 'INVALID_INPUT';

/**
 * Raised when a transaction definitively did not succeed: either it was
 * validated with a result other than `tesSUCCESS` (a `tec` code: the fee was
 * charged, `ledgerIndex`/`meta` are set) or it was rejected/expired without
 * ever being included in a validated ledger.
 */
export class TransactionFailedError extends Error {
  override readonly name = 'TransactionFailedError';

  constructor(
    readonly transactionType: string,
    readonly resultCode: string,
    readonly hash: string,
    readonly validated?: { ledgerIndex: number; meta: TransactionMetadata },
    detail?: string,
  ) {
    super(`${transactionType} ${hash} failed with ${resultCode}${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Raised when a transaction was signed and submitted but its final outcome
 * could not be determined (e.g. the connection dropped while waiting). The
 * transaction may or may not have been applied: look up `hash` before
 * retrying, otherwise the operation could be applied twice.
 */
export class TransactionOutcomeUnknownError extends Error {
  override readonly name = 'TransactionOutcomeUnknownError';

  constructor(
    readonly transactionType: string,
    readonly hash: string,
    readonly lastLedgerSequence: number | undefined,
    options: { cause: unknown },
  ) {
    super(
      `Outcome of ${transactionType} ${hash} is unknown; check the transaction on-ledger ` +
        `(final once ledger ${lastLedgerSequence ?? '?'} is validated) before retrying`,
      options,
    );
  }
}
