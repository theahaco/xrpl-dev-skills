"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionOutcomeUnknownError = exports.TransactionFailedError = exports.ComplianceError = void 0;
/**
 * Raised when the issuer module refuses an operation because it would violate
 * a compliance rule (for example, issuing to a banned or frozen holder).
 * Nothing is submitted to the ledger when this is thrown.
 */
class ComplianceError extends Error {
    code;
    name = 'ComplianceError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
exports.ComplianceError = ComplianceError;
/**
 * Raised when a transaction was submitted but did not end up validated with
 * `tesSUCCESS`. `resultCode` is the XRPL engine result (for example
 * `tecNO_AUTH`, `tecLOCKED`, `temMALFORMED`). `hash` is set whenever the
 * transaction was signed, so it can be looked up on a ledger explorer.
 */
class TransactionFailedError extends Error {
    transactionType;
    resultCode;
    hash;
    validated;
    name = 'TransactionFailedError';
    constructor(transactionType, resultCode, hash, message, 
    /** True if the transaction is known to be in a validated ledger (a `tec` code). */
    validated) {
        super(message);
        this.transactionType = transactionType;
        this.resultCode = resultCode;
        this.hash = hash;
        this.validated = validated;
    }
}
exports.TransactionFailedError = TransactionFailedError;
/**
 * Raised when the outcome of a submitted transaction could not be determined
 * (for example, the connection dropped before validation). The transaction MAY
 * have been applied. Callers must reconcile by looking up `hash` before
 * retrying any value-moving operation.
 */
class TransactionOutcomeUnknownError extends Error {
    transactionType;
    hash;
    lastLedgerSequence;
    name = 'TransactionOutcomeUnknownError';
    constructor(transactionType, hash, lastLedgerSequence, message, options) {
        super(message, options);
        this.transactionType = transactionType;
        this.hash = hash;
        this.lastLedgerSequence = lastLedgerSequence;
    }
}
exports.TransactionOutcomeUnknownError = TransactionOutcomeUnknownError;
//# sourceMappingURL=errors.js.map