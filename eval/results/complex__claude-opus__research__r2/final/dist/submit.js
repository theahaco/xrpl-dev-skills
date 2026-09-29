import { setTimeout as sleep } from 'node:timers/promises';
/**
 * Thrown when a transaction was validated with a result other than tesSUCCESS
 * (for example a `tec` code). The fee was spent, but nothing else changed.
 */
export class TransactionFailedError extends Error {
    transactionType;
    resultCode;
    hash;
    ledgerIndex;
    name = 'TransactionFailedError';
    constructor(transactionType, resultCode, hash, ledgerIndex) {
        super(`${transactionType} ${hash} failed with ${resultCode}`);
        this.transactionType = transactionType;
        this.resultCode = resultCode;
        this.hash = hash;
        this.ledgerIndex = ledgerIndex;
    }
}
/**
 * Thrown when a transaction was rejected before it could reach a ledger
 * (tem/tef/tel codes, or it expired unvalidated). The ledger was not changed.
 */
export class TransactionRejectedError extends Error {
    transactionType;
    resultCode;
    hash;
    name = 'TransactionRejectedError';
    constructor(transactionType, resultCode, hash, message) {
        super(`${transactionType} ${hash} was not applied (${resultCode}): ${message}`);
        this.transactionType = transactionType;
        this.resultCode = resultCode;
        this.hash = hash;
    }
}
const POLL_INTERVAL_MS = 1_000;
/** How many ledgers the transaction has to be validated before it expires. */
const LEDGER_OFFSET = 20;
/**
 * Autofill, sign, submit and wait for a transaction to reach a final outcome.
 *
 * Resolves only if the transaction is in a validated ledger with tesSUCCESS.
 * Rejects with TransactionFailedError when it is validated with another result,
 * and with TransactionRejectedError once it provably can never be validated:
 * either it was rejected outright, or a validated ledger has passed its
 * LastLedgerSequence without including it.
 */
export async function submitAndConfirm(client, wallet, transaction) {
    const prepared = await client.autofill(transaction);
    const validatedIndex = await client.getLedgerIndex();
    prepared.LastLedgerSequence = validatedIndex + LEDGER_OFFSET;
    const lastLedger = prepared.LastLedgerSequence;
    const { tx_blob: blob, hash } = wallet.sign(prepared);
    const type = transaction.TransactionType;
    const submitted = await client.request({ command: 'submit', tx_blob: blob });
    const preliminary = submitted.result.engine_result;
    // tem: malformed; tef: can never succeed (e.g. already used sequence).
    // Neither can reach a ledger, so there is nothing to wait for.
    if (preliminary.startsWith('tem') || preliminary.startsWith('tef')) {
        throw new TransactionRejectedError(type, preliminary, hash, submitted.result.engine_result_message);
    }
    for (;;) {
        await sleep(POLL_INTERVAL_MS);
        const found = await lookupTransaction(client, hash);
        if (found?.result.validated === true) {
            const meta = found.result.meta;
            if (meta === undefined || typeof meta === 'string') {
                throw new Error(`Validated transaction ${hash} has no metadata`);
            }
            const ledgerIndex = found.result.ledger_index;
            if (meta.TransactionResult !== 'tesSUCCESS') {
                throw new TransactionFailedError(type, meta.TransactionResult, hash, ledgerIndex);
            }
            if (ledgerIndex === undefined) {
                throw new Error(`Validated transaction ${hash} has no ledger index`);
            }
            return { hash, ledgerIndex, meta, response: found };
        }
        // Only a *validated* ledger past LastLedgerSequence proves the transaction
        // can never be included.
        const latestValidated = await client.getLedgerIndex();
        if (latestValidated > lastLedger) {
            // One more look, in case it was validated between the two requests.
            const final = await lookupTransaction(client, hash);
            if (final?.result.validated === true) {
                continue;
            }
            throw new TransactionRejectedError(type, preliminary, hash, `not validated by LastLedgerSequence ${lastLedger}`);
        }
    }
}
async function lookupTransaction(client, hash) {
    try {
        return await client.request({ command: 'tx', transaction: hash });
    }
    catch (error) {
        if (errorCode(error) === 'txnNotFound') {
            return undefined;
        }
        throw error;
    }
}
/** Extract the rippled error code from an xrpl.js request error, if any. */
export function errorCode(error) {
    if (typeof error !== 'object' || error === null || !('data' in error)) {
        return undefined;
    }
    const data = error.data;
    if (typeof data === 'object' && data !== null && 'error' in data) {
        const code = data.error;
        return typeof code === 'string' ? code : undefined;
    }
    return undefined;
}
//# sourceMappingURL=submit.js.map