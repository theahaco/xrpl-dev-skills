import { RippledError, } from 'xrpl';
import { ComplianceError, TransactionFailedError } from './errors.js';
/**
 * Serializes async work. Transactions from one account must be signed in
 * order, or autofilled `Sequence` numbers collide.
 */
export class SerialQueue {
    tail = Promise.resolve();
    run(task) {
        const next = this.tail.then(task, task);
        this.tail = next.catch(() => undefined);
        return next;
    }
}
const queues = new WeakMap();
function queueFor(client, address) {
    let perClient = queues.get(client);
    if (!perClient) {
        perClient = new Map();
        queues.set(client, perClient);
    }
    let queue = perClient.get(address);
    if (!queue) {
        queue = new SerialQueue();
        perClient.set(address, queue);
    }
    return queue;
}
/**
 * Autofills, signs and submits a transaction, then waits until it is in a
 * validated ledger. Returns the final outcome whether it succeeded or not.
 * Throws `TransactionFailedError` only if there is no final outcome: the
 * transaction was malformed (`tem`), rejected before being queued, or its
 * `LastLedgerSequence` passed without it being found. In the last case,
 * look up the hash before retrying.
 */
export async function submitAndWaitForOutcome(client, wallet, tx) {
    return queueFor(client, wallet.classicAddress).run(async () => {
        let hash;
        try {
            const prepared = await client.autofill(tx);
            const signed = wallet.sign(prepared);
            hash = signed.hash;
            const response = await client.submitAndWait(signed.tx_blob);
            const meta = response.result.meta;
            if (!response.result.validated || typeof meta !== 'object' || meta === null) {
                throw new Error('Transaction response is not validated or has no metadata');
            }
            return {
                hash: response.result.hash,
                result: meta.TransactionResult,
                ledgerIndex: response.result.ledger_index ?? 0,
                meta,
            };
        }
        catch (err) {
            if (err instanceof TransactionFailedError)
                throw err;
            const detail = err instanceof Error ? err.message : String(err);
            throw new TransactionFailedError(tx.TransactionType, engineResultFrom(detail) ?? 'UNKNOWN', hash, `${tx.TransactionType} did not reach a final validated outcome` +
                (hash ? ` (hash ${hash})` : '') +
                `: ${detail}`, { cause: err });
        }
    });
}
/** Like `submitAndWaitForOutcome`, but throws unless the result is `tesSUCCESS`. */
export async function submitAndRequireSuccess(client, wallet, tx) {
    const outcome = await submitAndWaitForOutcome(client, wallet, tx);
    if (outcome.result !== 'tesSUCCESS') {
        throw new TransactionFailedError(tx.TransactionType, outcome.result, outcome.hash, `${tx.TransactionType} failed with ${outcome.result} (hash ${outcome.hash}, ledger ${outcome.ledgerIndex})`);
    }
    return outcome;
}
function engineResultFrom(message) {
    return /\b(te[cfmlr][A-Z_]+)\b/.exec(message)?.[1];
}
/** Reads a ledger entry from the latest validated ledger; `undefined` if it doesn't exist. */
export async function readValidatedEntry(client, selector) {
    try {
        const response = await client.request({ command: 'ledger_entry', ledger_index: 'validated', ...selector });
        return response.result.node;
    }
    catch (err) {
        if (err instanceof RippledError && err.data?.error === 'entryNotFound') {
            return undefined;
        }
        throw err;
    }
}
/**
 * Checks that the connected server reports the given amendments as enabled.
 * Throws if any is disabled or unknown.
 */
export async function assertAmendmentsEnabled(client, names) {
    const response = await client.request({ command: 'feature' });
    const features = Object.values(response.result.features ?? {});
    const missing = names.filter((name) => !features.some((f) => f.name === name && f.enabled));
    if (missing.length > 0) {
        throw new ComplianceError('AMENDMENT_NOT_ENABLED', `Required amendment(s) not enabled on this network: ${missing.join(', ')}`);
    }
}
/** Returns the change in a holder's `MPTAmount` recorded in a transaction's metadata. */
export function mptBalanceDelta(meta, issuanceId, holder) {
    for (const node of meta.AffectedNodes) {
        const entry = 'ModifiedNode' in node ? node.ModifiedNode : 'DeletedNode' in node ? node.DeletedNode : undefined;
        if (!entry || entry.LedgerEntryType !== 'MPToken')
            continue;
        const finalFields = entry.FinalFields;
        if (finalFields?.Account !== holder || finalFields.MPTokenIssuanceID !== issuanceId)
            continue;
        const previous = entry.PreviousFields?.MPTAmount;
        if (previous === undefined)
            return 0n;
        return BigInt(finalFields.MPTAmount ?? '0') - BigInt(previous);
    }
    return 0n;
}
//# sourceMappingURL=ledger.js.map