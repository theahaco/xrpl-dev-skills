/** Base class for every error raised by this module. */
export class MptIssuerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** A transaction reached a final, non-successful result (or never validated). */
export class TransactionFailedError extends MptIssuerError {
  readonly transactionType: string
  readonly resultCode: string
  readonly hash: string | undefined

  constructor(transactionType: string, resultCode: string, hash?: string, options?: ErrorOptions) {
    super(`${transactionType} failed with ${resultCode}${hash ? ` (tx ${hash})` : ''}`, options)
    this.transactionType = transactionType
    this.resultCode = resultCode
    this.hash = hash
  }
}

/** The issuance on ledger does not have the settings this module relies on. */
export class ComplianceConfigError extends MptIssuerError {}

/** The operation was refused because the address is on the ban list. */
export class BannedHolderError extends MptIssuerError {
  readonly address: string

  constructor(address: string) {
    super(`${address} is banned from holding this token`)
    this.address = address
  }
}

/** The holder has not opted in to the token (no MPToken entry on ledger). */
export class HolderNotOptedInError extends MptIssuerError {
  readonly address: string

  constructor(address: string) {
    super(
      `${address} has no MPToken entry for this issuance; the holder must submit an MPTokenAuthorize transaction first`,
    )
    this.address = address
  }
}

/** A post-condition check against the validated ledger did not hold. */
export class LedgerStateMismatchError extends MptIssuerError {}

/** The issuer refused to move tokens because the holder or the whole token is frozen. */
export class FrozenError extends MptIssuerError {}

/** The holder is not on the allowlist. */
export class HolderNotApprovedError extends MptIssuerError {
  readonly address: string

  constructor(address: string) {
    super(`${address} is not approved to hold this token`)
    this.address = address
  }
}
