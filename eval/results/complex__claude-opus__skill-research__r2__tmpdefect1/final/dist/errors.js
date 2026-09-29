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
export class ComplianceError extends Error {
    code;
    name = 'ComplianceError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export class TransactionFailedError extends Error {
    transactionType;
    resultCode;
    hash;
    name = 'TransactionFailedError';
    constructor(transactionType, 
    /** Engine result code (e.g. `tecNO_AUTH`), or `UNKNOWN` if the final outcome could not be determined. */
    resultCode, 
    /** Transaction hash, if the transaction was signed. */
    hash, message, options) {
        super(message, options);
        this.transactionType = transactionType;
        this.resultCode = resultCode;
        this.hash = hash;
    }
}
//# sourceMappingURL=errors.js.map