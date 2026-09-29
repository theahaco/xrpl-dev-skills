"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionSubmitter = void 0;
const errors_js_1 = require("./errors.js");
/**
 * Signs and submits transactions and waits for a final, validated outcome.
 *
 * - Transactions from the same account are serialized, so concurrent callers
 *   can't race on the account Sequence.
 * - The transaction hash is known before submission, so a dropped connection
 *   leads to reconciliation by hash rather than a blind (double-spending) retry.
 * - "Not applied" is only concluded once a *validated* ledger has passed the
 *   transaction's LastLedgerSequence.
 */
class TransactionSubmitter {
    client;
    queues = new Map();
    pollIntervalMs;
    outcomeTimeoutMs;
    constructor(client, options = {}) {
        this.client = client;
        this.pollIntervalMs = options.pollIntervalMs ?? 1000;
        this.outcomeTimeoutMs = options.outcomeTimeoutMs ?? 120_000;
    }
    /** Submits and returns the validated outcome; throws TransactionFailedError unless tesSUCCESS. */
    async submit(wallet, tx) {
        const outcome = await this.submitForOutcome(wallet, tx);
        if (outcome.resultCode !== 'tesSUCCESS') {
            throw new errors_js_1.TransactionFailedError(tx.TransactionType, outcome.resultCode, outcome.hash);
        }
        return outcome;
    }
    /**
     * Submits and returns the validated outcome whatever its result code (tesSUCCESS or tec*).
     * Still throws for transactions that were never applied (tem/tef/tel, or expired).
     */
    async submitForOutcome(wallet, tx) {
        return this.serialized(wallet.classicAddress, () => this.signSubmitAndWait(wallet, tx));
    }
    async serialized(key, task) {
        const previous = this.queues.get(key) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(task);
        this.queues.set(key, run);
        try {
            return await run;
        }
        finally {
            if (this.queues.get(key) === run)
                this.queues.delete(key);
        }
    }
    async signSubmitAndWait(wallet, tx) {
        const prepared = await this.client.autofill({ ...tx, Account: wallet.classicAddress });
        const lastLedgerSequence = prepared.LastLedgerSequence;
        if (lastLedgerSequence === undefined) {
            throw new Error('autofill did not set LastLedgerSequence; refusing to submit without an expiry');
        }
        const { tx_blob: txBlob, hash } = wallet.sign(prepared);
        let preliminary;
        try {
            const response = await this.client.request({ command: 'submit', tx_blob: txBlob });
            preliminary = response.result.engine_result;
        }
        catch {
            // The server may or may not have received it. Fall through to reconciliation by hash.
        }
        // tem/tef/tel: the transaction was rejected outright and can never be included in a ledger.
        if (preliminary !== undefined && /^(tem|tef|tel)/.test(preliminary)) {
            throw new errors_js_1.TransactionFailedError(tx.TransactionType, preliminary, hash);
        }
        return this.waitForValidation(tx.TransactionType, hash, lastLedgerSequence);
    }
    async waitForValidation(transactionType, hash, lastLedgerSequence) {
        let lastConnectivityOk = Date.now();
        let lastError;
        for (;;) {
            await sleep(this.pollIntervalMs);
            try {
                const found = await this.lookupValidated(hash);
                if (found)
                    return found;
                const validatedIndex = await this.client.getLedgerIndex();
                if (validatedIndex > lastLedgerSequence) {
                    // One final lookup closes the race between the two requests above.
                    const lateFound = await this.lookupValidated(hash);
                    if (lateFound)
                        return lateFound;
                    throw new errors_js_1.TransactionFailedError(transactionType, 'EXPIRED_NOT_APPLIED', hash);
                }
                lastConnectivityOk = Date.now();
            }
            catch (error) {
                if (error instanceof errors_js_1.TransactionFailedError)
                    throw error;
                lastError = error;
                if (Date.now() - lastConnectivityOk > this.outcomeTimeoutMs) {
                    throw new errors_js_1.TransactionOutcomeUnknownError(transactionType, hash, lastLedgerSequence, { cause: lastError });
                }
            }
        }
    }
    async lookupValidated(hash) {
        try {
            const response = await this.client.request({ command: 'tx', transaction: hash });
            const { result } = response;
            if (!result.validated || typeof result.meta !== 'object' || result.ledger_index === undefined) {
                return undefined;
            }
            return { hash, resultCode: result.meta.TransactionResult, ledgerIndex: result.ledger_index, meta: result.meta };
        }
        catch (error) {
            if (isTxnNotFound(error))
                return undefined;
            throw error;
        }
    }
}
exports.TransactionSubmitter = TransactionSubmitter;
function isTxnNotFound(error) {
    const data = error?.data;
    return data?.error === 'txnNotFound';
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=submit.js.map