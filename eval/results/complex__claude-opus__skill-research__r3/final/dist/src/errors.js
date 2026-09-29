"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionOutcomeUnknownError = exports.TransactionFailedError = exports.LedgerStateError = exports.ComplianceViolationError = exports.ValidationError = exports.IssuerError = void 0;
/** Base class for every error raised by this package. */
class IssuerError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = new.target.name;
    }
}
exports.IssuerError = IssuerError;
/** Invalid input from the caller (bad address, malformed amount, ...). */
class ValidationError extends IssuerError {
}
exports.ValidationError = ValidationError;
/**
 * A compliance rule forbids the requested action, e.g. approving a banned
 * address or issuing to a frozen holder. Nothing was submitted to the ledger.
 */
class ComplianceViolationError extends IssuerError {
}
exports.ComplianceViolationError = ComplianceViolationError;
/** The on-ledger state does not match what the module requires. */
class LedgerStateError extends IssuerError {
}
exports.LedgerStateError = LedgerStateError;
/**
 * A transaction was validated by the network with a non-success result
 * (a `tec` code). The fee was spent, but the transaction had no other effect.
 */
class TransactionFailedError extends IssuerError {
    transactionType;
    resultCode;
    hash;
    constructor(transactionType, resultCode, hash) {
        super(`${transactionType} failed on ledger with ${resultCode} (tx ${hash})`);
        this.transactionType = transactionType;
        this.resultCode = resultCode;
        this.hash = hash;
    }
}
exports.TransactionFailedError = TransactionFailedError;
/**
 * The outcome of a transaction could not be determined (e.g. the connection
 * dropped and the transaction had not expired yet). The transaction MAY still
 * be validated later; reconcile using `hash` before retrying.
 */
class TransactionOutcomeUnknownError extends IssuerError {
    transactionType;
    hash;
    lastLedgerSequence;
    constructor(transactionType, hash, lastLedgerSequence, options) {
        super(`Outcome of ${transactionType} ${hash} is unknown (LastLedgerSequence ${lastLedgerSequence ?? 'unset'}); check the hash before retrying`, options);
        this.transactionType = transactionType;
        this.hash = hash;
        this.lastLedgerSequence = lastLedgerSequence;
    }
}
exports.TransactionOutcomeUnknownError = TransactionOutcomeUnknownError;
//# sourceMappingURL=errors.js.map