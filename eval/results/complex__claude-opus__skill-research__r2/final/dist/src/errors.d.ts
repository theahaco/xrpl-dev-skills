/**
 * Raised when the issuer module refuses an operation because it would violate
 * a compliance rule (for example, issuing to a banned or frozen holder).
 * Nothing is submitted to the ledger when this is thrown.
 */
export declare class ComplianceError extends Error {
    readonly code: ComplianceErrorCode;
    readonly name = "ComplianceError";
    constructor(code: ComplianceErrorCode, message: string);
}
export type ComplianceErrorCode = 'HOLDER_BANNED' | 'HOLDER_NOT_APPROVED' | 'HOLDER_NOT_OPTED_IN' | 'HOLDER_FROZEN' | 'GLOBALLY_FROZEN' | 'INVALID_HOLDER' | 'ISSUANCE_MISCONFIGURED';
/**
 * Raised when a transaction was submitted but did not end up validated with
 * `tesSUCCESS`. `resultCode` is the XRPL engine result (for example
 * `tecNO_AUTH`, `tecLOCKED`, `temMALFORMED`). `hash` is set whenever the
 * transaction was signed, so it can be looked up on a ledger explorer.
 */
export declare class TransactionFailedError extends Error {
    readonly transactionType: string;
    readonly resultCode: string;
    readonly hash: string | undefined;
    /** True if the transaction is known to be in a validated ledger (a `tec` code). */
    readonly validated: boolean;
    readonly name = "TransactionFailedError";
    constructor(transactionType: string, resultCode: string, hash: string | undefined, message: string, 
    /** True if the transaction is known to be in a validated ledger (a `tec` code). */
    validated: boolean);
}
/**
 * Raised when the outcome of a submitted transaction could not be determined
 * (for example, the connection dropped before validation). The transaction MAY
 * have been applied. Callers must reconcile by looking up `hash` before
 * retrying any value-moving operation.
 */
export declare class TransactionOutcomeUnknownError extends Error {
    readonly transactionType: string;
    readonly hash: string;
    readonly lastLedgerSequence: number;
    readonly name = "TransactionOutcomeUnknownError";
    constructor(transactionType: string, hash: string, lastLedgerSequence: number, message: string, options?: {
        cause?: unknown;
    });
}
