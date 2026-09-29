"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IssuerInputError = exports.IssuerTransactionError = void 0;
/**
 * Thrown whenever a transaction submitted by the issuer module does not
 * validate with `tesSUCCESS`. Carries enough detail (engine result, tx hash,
 * transaction type) for compliance logging and incident response.
 */
class IssuerTransactionError extends Error {
    transactionType;
    engineResult;
    txHash;
    constructor(message, transactionType, engineResult, txHash) {
        super(message);
        this.name = "IssuerTransactionError";
        this.transactionType = transactionType;
        this.engineResult = engineResult;
        this.txHash = txHash;
    }
}
exports.IssuerTransactionError = IssuerTransactionError;
/** Thrown for invalid arguments (bad address, non-positive amount, etc.). */
class IssuerInputError extends Error {
    constructor(message) {
        super(message);
        this.name = "IssuerInputError";
    }
}
exports.IssuerInputError = IssuerInputError;
//# sourceMappingURL=errors.js.map