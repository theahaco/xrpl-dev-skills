/** Base class for every error this module throws on purpose. */
export declare class IssuerError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** A caller passed an invalid argument (address, amount, ...). Nothing was submitted. */
export declare class InvalidInputError extends IssuerError {
}
/**
 * The module refused the operation because it would violate a compliance rule
 * (for example, approving a banned address or sending to a frozen holder).
 * Nothing was submitted.
 */
export declare class PolicyViolationError extends IssuerError {
}
/** The issuance on the ledger lacks a capability that this module requires. */
export declare class IssuanceConfigurationError extends IssuerError {
}
/** A transaction was validated with a result other than tesSUCCESS. */
export declare class TransactionFailedError extends IssuerError {
    readonly transactionType: string;
    readonly resultCode: string;
    readonly hash: string;
    constructor(transactionType: string, resultCode: string, hash: string);
}
/** After an operation, the ledger was not in the state the operation should have produced. */
export declare class PostConditionError extends IssuerError {
}
