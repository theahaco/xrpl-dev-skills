"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionSubmitter = exports.silentLogger = void 0;
const promises_1 = require("node:timers/promises");
const errors_js_1 = require("./errors.js");
const MAX_CONSECUTIVE_POLL_ERRORS = 5;
exports.silentLogger = {
    info: () => undefined,
    warn: () => undefined,
};
/**
 * Signs and submits transactions for one account and waits for a final,
 * validated outcome.
 *
 * - Submissions are serialized, so concurrent callers never race on the
 *   account's Sequence number.
 * - Every transaction gets a LastLedgerSequence (via autofill). Once that
 *   ledger is validated without the transaction, it can never be applied,
 *   which is what makes failures final.
 * - Only `tesSUCCESS` in a validated ledger counts as success; anything else
 *   throws `TransactionFailedError`. If the outcome cannot be determined, it
 *   throws `TransactionOutcomeUnknownError` with the hash so the caller can
 *   reconcile before retrying.
 */
class TransactionSubmitter {
    #client;
    #wallet;
    #logger;
    #pollIntervalMs;
    #queue = Promise.resolve();
    constructor(client, wallet, options = {}) {
        this.#client = client;
        this.#wallet = wallet;
        this.#logger = options.logger ?? exports.silentLogger;
        this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    }
    get address() {
        return this.#wallet.classicAddress;
    }
    submit(tx) {
        const run = this.#queue.then(() => this.#submitOne(tx));
        this.#queue = run.catch(() => undefined);
        return run;
    }
    async #submitOne(tx) {
        if (tx.Account !== this.#wallet.classicAddress) {
            throw new Error(`Refusing to sign ${tx.TransactionType} for ${tx.Account} with the key of ${this.#wallet.classicAddress}`);
        }
        const prepared = await this.#client.autofill(tx);
        const lastLedgerSequence = prepared.LastLedgerSequence;
        if (lastLedgerSequence === undefined) {
            throw new Error('autofill did not set LastLedgerSequence; refusing to submit');
        }
        const { tx_blob: txBlob, hash } = this.#wallet.sign(prepared);
        const type = tx.TransactionType;
        const submitted = await this.#client.request({ command: 'submit', tx_blob: txBlob });
        const preliminary = submitted.result.engine_result;
        this.#logger.info('tx.submitted', { type, hash, preliminary, sequence: prepared.Sequence });
        // tem (malformed) and tef (failed, e.g. past sequence) results can never
        // be applied later. tel/ter results are provisional, so we wait for the
        // final outcome like we do for tes/tec.
        if (preliminary.startsWith('tem') || preliminary.startsWith('tef')) {
            throw new errors_js_1.TransactionFailedError(type, preliminary, hash, `${type} rejected: ${preliminary} (${submitted.result.engine_result_message})`, false);
        }
        const outcome = await this.#waitForValidation(type, hash, lastLedgerSequence, preliminary);
        const result = outcome.meta.TransactionResult;
        if (result !== 'tesSUCCESS') {
            this.#logger.warn('tx.failed', { type, hash, result, ledgerIndex: outcome.ledgerIndex });
            throw new errors_js_1.TransactionFailedError(type, result, hash, `${type} failed in validated ledger ${outcome.ledgerIndex}: ${result}`, true);
        }
        this.#logger.info('tx.validated', { type, hash, result, ledgerIndex: outcome.ledgerIndex });
        return outcome;
    }
    async #waitForValidation(type, hash, lastLedgerSequence, preliminary) {
        let consecutiveErrors = 0;
        for (;;) {
            await (0, promises_1.setTimeout)(this.#pollIntervalMs);
            try {
                const response = await this.#client
                    .request({ command: 'tx', transaction: hash })
                    .catch((error) => {
                    if (error.data?.error === 'txnNotFound') {
                        return undefined;
                    }
                    throw error;
                });
                consecutiveErrors = 0;
                if (response?.result.validated === true) {
                    const meta = response.result.meta;
                    const ledgerIndex = response.result.ledger_index;
                    if (typeof meta !== 'object' || ledgerIndex === undefined) {
                        throw new Error(`Validated response for ${hash} is missing metadata`);
                    }
                    return { hash, ledgerIndex, meta };
                }
                const validatedLedger = await this.#client.getLedgerIndex();
                if (validatedLedger > lastLedgerSequence) {
                    // Re-check once: the tx may have been validated in the ledger we
                    // just learned about, between the two requests above.
                    const recheck = await this.#client
                        .request({ command: 'tx', transaction: hash })
                        .catch(() => undefined);
                    if (recheck?.result.validated === true && typeof recheck.result.meta === 'object') {
                        return { hash, ledgerIndex: recheck.result.ledger_index ?? validatedLedger, meta: recheck.result.meta };
                    }
                    throw new errors_js_1.TransactionFailedError(type, preliminary, hash, `${type} expired: not included by LastLedgerSequence ${lastLedgerSequence} (preliminary ${preliminary})`, false);
                }
            }
            catch (error) {
                if (error instanceof errors_js_1.TransactionFailedError) {
                    throw error;
                }
                consecutiveErrors += 1;
                this.#logger.warn('tx.poll_error', { type, hash, attempt: consecutiveErrors, error: String(error) });
                if (consecutiveErrors < MAX_CONSECUTIVE_POLL_ERRORS) {
                    continue;
                }
                throw new errors_js_1.TransactionOutcomeUnknownError(type, hash, lastLedgerSequence, `Could not determine the outcome of ${type} ${hash}; reconcile before retrying`, { cause: error });
            }
        }
    }
}
exports.TransactionSubmitter = TransactionSubmitter;
//# sourceMappingURL=submitter.js.map