/** Base class for every error raised by this module. */
export class MptIssuerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Input failed validation before anything was sent to the ledger. */
export class ValidationError extends MptIssuerError {}

/** The operation is refused by local policy (e.g. the address is banned). */
export class PolicyError extends MptIssuerError {}

/** The holder is on the ban list. Nothing was submitted to the ledger. */
export class HolderBannedError extends PolicyError {
  constructor(readonly holder: string) {
    super(`Holder ${holder} is banned`)
  }
}

/** The holder has no MPToken entry, i.e. has not opted in to the token yet. */
export class HolderNotOptedInError extends MptIssuerError {
  constructor(readonly holder: string) {
    super(`Holder ${holder} has not opted in to the token (no MPToken entry); they must submit MPTokenAuthorize first`)
  }
}

/** The on-ledger issuance does not match what this module requires. */
export class IssuanceConfigError extends MptIssuerError {}

/**
 * A transaction was submitted but did not succeed. `code` is the engine result,
 * e.g. `tecNO_AUTH`, `tecLOCKED`, `temMALFORMED`.
 *
 * `applied` is true when the transaction made it into a validated ledger (a `tec`
 * result: the fee was charged but nothing else changed). It is false when the
 * transaction was rejected before it could be included (`tem`/`tef`/`tel`).
 */
export class TransactionFailedError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly code: string,
    readonly hash: string,
    readonly applied: boolean,
    detail?: string,
  ) {
    super(`${transactionType} failed with ${code}${detail ? `: ${detail}` : ''} (tx ${hash})`)
  }
}

/**
 * The transaction's LastLedgerSequence passed without it being validated. It is
 * guaranteed not to be applied, so it is safe to rebuild and resubmit.
 */
export class TransactionExpiredError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    readonly lastLedgerSequence: number,
  ) {
    super(`${transactionType} ${hash} was not validated by ledger ${lastLedgerSequence}; it will never be applied`)
  }
}
