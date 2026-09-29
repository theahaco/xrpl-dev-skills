import { Client, Wallet } from 'xrpl';
import { Store } from './store.js';
export class LedgerFailure extends Error {
    receipt;
    constructor(receipt) {
        super(`${receipt.code}: ${receipt.hash}`);
        this.receipt = receipt;
    }
}
export function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object')
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    return JSON.stringify(value);
}
export function rpcCode(error) {
    if (typeof error !== 'object' || error === null || !('data' in error))
        return undefined;
    const d = error.data;
    return typeof d === 'object' && d !== null && 'error' in d ? String(d.error) : undefined;
}
/** Stable operation IDs provide at-most-once submission, including after crashes. */
export class Submitter {
    client;
    store;
    tail = Promise.resolve();
    constructor(client, store) {
        this.client = client;
        this.store = store;
    }
    exclusive(work) {
        const result = this.tail.then(work);
        this.tail = result.catch(() => undefined);
        return result;
    }
    async send(id, tx, signer) {
        if (!id.trim())
            throw new Error('Operation ID required');
        if (tx.Account !== signer.classicAddress)
            throw new Error('Signer/account mismatch');
        const intent = canonical(tx);
        let p = this.store.getTx(id);
        if (p && p.intent !== intent)
            throw new Error(`Operation ID reused with different intent: ${id}`);
        if (p?.receipt)
            return this.check(JSON.parse(p.receipt));
        const pending = this.store.pendingId();
        if (pending && pending !== id)
            throw new Error(`Reconcile pending operation first: ${pending}`);
        if (!p) {
            const filled = await this.client.autofill(tx);
            if (!filled.Sequence || !filled.LastLedgerSequence || !filled.Fee || BigInt(filled.Fee) > 10000n)
                throw new Error('Invalid sequence, expiry or fee exceeds 0.01 XRP');
            const signed = signer.sign(filled);
            this.store.prepare(id, { intent, blob: signed.tx_blob, hash: signed.hash, sequence: filled.Sequence, lastLedger: filled.LastLedgerSequence });
            p = this.store.getTx(id);
        }
        let response;
        try {
            const found = await this.client.request({ command: 'tx', transaction: p.hash });
            if (found.result.validated)
                response = found;
        }
        catch (e) {
            if (rpcCode(e) !== 'txnNotFound')
                throw e;
        }
        if (!response) {
            // Never re-sign on timeout/expiry: the original hash is the reconciliation key.
            // submitAndWait checks the hash and LastLedgerSequence using reliable submission.
            try {
                response = await this.client.submitAndWait(p.blob);
            }
            catch (e) {
                throw new Error(`Unresolved operation ${id}; reconcile hash ${p.hash} (expires ${p.lastLedger}). Do not use a new ID.`, { cause: e });
            }
        }
        const { result } = response;
        if (!result.validated || !result.ledger_index || !result.meta || typeof result.meta === 'string')
            throw new Error(`Unvalidated or missing metadata: ${p.hash}`);
        const receipt = { hash: p.hash, ledger: result.ledger_index, code: result.meta.TransactionResult, sequence: p.sequence };
        this.store.finish(id, receipt);
        console.log(`${id}: ${receipt.code} ${receipt.hash}`);
        return this.check(receipt);
    }
    check(r) { if (r.code !== 'tesSUCCESS')
        throw new LedgerFailure(r); return r; }
}
