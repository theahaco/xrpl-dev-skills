/** Base class for every error raised by this package. */
export declare class IssuerError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** Invalid input from the caller (bad address, malformed amount, ...). */
export declare class ValidationError extends IssuerError {
}
/**
 * A compliance rule forbids the requested action, e.g. approving a banned
 * address or issuing to a frozen holder. Nothing was submitted to the ledger.
 */
export declare class ComplianceViolationError extends IssuerError {
}
/** The on-ledger state does not match what the module requires. */
export declare class LedgerStateError extends IssuerError {
}
/**
 * A transaction was validated by the network with a non-success result
 * (a `tec` code). The fee was spent, but the transaction had no other effect.
 */
export declare class TransactionFailedError extends IssuerError {
    readonly transactionType: string;
    readonly resultCode: string;
    readonly hash: string;
    constructor(transactionType: string, resultCode: string, hash: string);
}
/**
 * The outcome of a transaction could not be determined (e.g. the connection
 * dropped and the transaction had not expired yet). The transaction MAY still
 * be validated later; reconcile using `hash` before retrying.
 */
export declare class TransactionOutcomeUnknownError extends IssuerError {
    readonly transactionType: string;
    readonly hash: string;
    readonly lastLedgerSequence: number | undefined;
    constructor(transactionType: string, hash: string, lastLedgerSequence: number | undefined, options?: ErrorOptions);
}
