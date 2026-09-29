"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionFailedError = void 0;
exports.submitAndVerify = submitAndVerify;
class TransactionFailedError extends Error {
    constructor(transactionType, resultCode, hash) {
        super(`${transactionType} failed with result ${resultCode} (hash: ${hash ?? "unknown"})`);
        this.transactionType = transactionType;
        this.resultCode = resultCode;
        this.hash = hash;
        this.name = "TransactionFailedError";
    }
}
exports.TransactionFailedError = TransactionFailedError;
/**
 * Autofills, signs, submits, and waits for validation of a transaction, then
 * throws unless the validated result is exactly `tesSUCCESS`.
 *
 * Never trusts the initial submission response alone — only a validated
 * ledger result is treated as final, per XRPL reliable-submission guidance.
 */
async function submitAndVerify(client, wallet, transaction) {
    const prepared = await client.autofill(transaction);
    const response = await client.submitAndWait(prepared, { wallet, autofill: false });
    const meta = response.result.meta;
    const resultCode = typeof meta === "object" && meta !== null && "TransactionResult" in meta
        ? String(meta.TransactionResult)
        : undefined;
    if (resultCode !== "tesSUCCESS") {
        throw new TransactionFailedError(transaction.TransactionType, resultCode ?? "UNKNOWN", response.result.hash);
    }
    return response;
}
//# sourceMappingURL=txSubmit.js.map