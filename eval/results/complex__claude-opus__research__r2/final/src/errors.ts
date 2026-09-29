/** Base class for every error this module throws on purpose. */
export class IssuerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** A caller passed an invalid argument (address, amount, ...). Nothing was submitted. */
export class InvalidInputError extends IssuerError {}

/**
 * The module refused the operation because it would violate a compliance rule
 * (for example, approving a banned address or sending to a frozen holder).
 * Nothing was submitted.
 */
export class PolicyViolationError extends IssuerError {}

/** The issuance on the ledger lacks a capability that this module requires. */
export class IssuanceConfigurationError extends IssuerError {}

/** A transaction was validated with a result other than tesSUCCESS. */
export class TransactionFailedError extends IssuerError {
  constructor(
    readonly transactionType: string,
    readonly resultCode: string,
    readonly hash: string,
  ) {
    super(`${transactionType} failed with ${resultCode} (tx ${hash})`)
  }
}

/** After an operation, the ledger was not in the state the operation should have produced. */
export class PostConditionError extends IssuerError {}
