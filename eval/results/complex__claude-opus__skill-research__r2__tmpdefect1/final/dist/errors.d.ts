/**
 * Error types raised by the issuer module.
 *
 * - `ComplianceError`: the module refused to act because a compliance rule
 *   would be violated. Nothing was submitted to the ledger.
 * - `TransactionFailedError`: a transaction was submitted but did not succeed.
 *   `hash` is set whenever the transaction was signed, so operators can
 *   reconcile the outcome on-ledger (a `tec` result is final and cost a fee;
 *   an unknown outcome must be checked by hash before retrying).
 */
export type ComplianceErrorCode = 'HOLDER_BANNED' | 'HOLDER_NOT_AUTHORIZED' | 'HOLDER_NOT_OPTED_IN' | 'HOLDER_FROZEN' | 'GLOBALLY_FROZEN' | 'INSUFFICIENT_BALANCE' | 'INVALID_ADDRESS' | 'INVALID_AMOUNT' | 'INVALID_ARGUMENT' | 'ISSUANCE_MISCONFIGURED' | 'WRONG_NETWORK' | 'AMENDMENT_NOT_ENABLED' | 'BAN_POSTCONDITION_FAILED';
export declare class ComplianceError extends Error {
    readonly code: ComplianceErrorCode;
    readonly name = "ComplianceError";
    constructor(code: ComplianceErrorCode, message: string);
}
export declare class TransactionFailedError extends Error {
    readonly transactionType: string;
    /** Engine result code (e.g. `tecNO_AUTH`), or `UNKNOWN` if the final outcome could not be determined. */
    readonly resultCode: string;
    /** Transaction hash, if the transaction was signed. */
    readonly hash: string | undefined;
    readonly name = "TransactionFailedError";
    constructor(transactionType: string, 
    /** Engine result code (e.g. `tecNO_AUTH`), or `UNKNOWN` if the final outcome could not be determined. */
    resultCode: string, 
    /** Transaction hash, if the transaction was signed. */
    hash: string | undefined, message: string, options?: {
        cause?: unknown;
    });
}
