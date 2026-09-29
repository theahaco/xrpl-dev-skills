import { createHash } from 'node:crypto';
export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export class LedgerFailure extends Error {
    receipt;
    constructor(receipt) {
        super(`Validated transaction ${receipt.hash}: ${receipt.code}`);
        this.receipt = receipt;
    }
}
export class ExpiredTransaction extends Error {
    hash;
    constructor(hash) {
        super(`Transaction ${hash} definitively expired without validation. Use a new operation ID only if still intended.`);
        this.hash = hash;
    }
}
export class PendingTransaction extends Error {
    hash;
    lastLedger;
    constructor(hash, lastLedger, options) {
        super(`Outcome unresolved for ${hash}; retry the SAME operation ID. Expiry ledger: ${lastLedger}.`, options);
        this.hash = hash;
        this.lastLedger = lastLedger;
    }
}
export async function preflight(client) {
    const info = (await client.request({ command: 'server_info' })).result.info;
    if (info.network_id !== 1 || info.validated_ledger === undefined || info.validated_ledger.age > 30)
        throw new Error('Require a synced XRPL testnet server (network ID 1)');
    const result = (await client.request({ command: 'ledger_entry', index: '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4', ledger_index: 'validated' })).result;
    if (!result.validated || result.node.LedgerEntryType !== 'Amendments')
        throw new Error('Unvalidated amendment data');
    for (const name of ['MPTokensV1', 'Clawback', 'fixMPTDeliveredAmount']) {
        const id = createHash('sha512').update(name).digest('hex').slice(0, 64).toUpperCase();
        if (!result.node.Amendments?.includes(id))
            throw new Error(`Required amendment disabled: ${name}`);
    }
}
/** One instance, one writer process per issuer. The service owns the durable store. */
export class Ledger {
    client;
    store;
    tail = Promise.resolve();
    constructor(client, store) {
        this.client = client;
        this.store = store;
    }
    exclusive(fn) {
        const next = this.tail.then(fn);
        this.tail = next.catch(() => undefined);
        return next;
    }
    /** Call within exclusive(). IDs must be stable across caller retries. Never auto-resign uncertain transactions. */
    async send(id, tx, signer) {
        if (!id.trim())
            throw new Error('Operation ID is required');
        if (tx.Account !== signer.classicAddress)
            throw new Error('Signer/account mismatch');
        const fingerprint = createHash('sha256').update(JSON.stringify(tx)).digest('hex');
        const key = `tx:${id}`;
        let pending = this.store.get(key);
        if (pending && pending.fingerprint !== fingerprint)
            throw new Error(`Operation ID reused with different input: ${id}`);
        if (pending?.expired)
            throw new ExpiredTransaction(pending.hash);
        if (pending?.receipt)
            return this.success(pending.receipt);
        const active = this.store.get('active');
        if (active && active !== id)
            throw new Error(`Reconcile pending operation ${active} before sending another transaction`);
        await preflight(this.client);
        if (!pending) {
            const firstLedger = await this.client.getLedgerIndex();
            const prepared = await this.client.autofill(tx);
            if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 10000n)
                throw new Error('Missing expiry or fee exceeds 0.01 XRP');
            const signed = await signer.sign(prepared);
            pending = { fingerprint, blob: signed.tx_blob, hash: signed.hash, lastLedger: prepared.LastLedgerSequence, firstLedger };
            this.store.atomic(() => { this.store.put('active', id); this.store.put(key, pending); });
        }
        try {
            const result = (await this.client.submitAndWait(pending.blob)).result;
            if (!result.validated || result.ledger_index === undefined || !result.meta || typeof result.meta === 'string')
                throw new Error('Missing validated metadata');
            const receipt = { hash: pending.hash, ledger: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta };
            this.store.atomic(() => { this.store.put(key, { ...pending, receipt }); this.store.put('active', null); });
            return this.success(receipt);
        }
        catch (error) {
            if (error instanceof LedgerFailure)
                throw error;
            // Lost responses and tefPAST_SEQ are resolved by hash, never by sending a second payment.
            try {
                const result = (await this.client.request({ command: 'tx', transaction: pending.hash, min_ledger: pending.firstLedger ?? 1, max_ledger: pending.lastLedger })).result;
                if (result.validated && result.ledger_index !== undefined && result.meta && typeof result.meta !== 'string') {
                    const receipt = { hash: pending.hash, ledger: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta };
                    this.store.atomic(() => { this.store.put(key, { ...pending, receipt }); this.store.put('active', null); });
                    return this.success(receipt);
                }
            }
            catch (lookupError) {
                if (lookupError instanceof LedgerFailure)
                    throw lookupError;
                const data = lookupError && typeof lookupError === 'object' && 'data' in lookupError
                    ? lookupError.data : undefined;
                if (data?.error === 'txnNotFound' && data.searched_all === true && await this.client.getLedgerIndex() > pending.lastLedger) {
                    this.store.atomic(() => { this.store.put(key, { ...pending, expired: true }); this.store.put('active', null); });
                    throw new ExpiredTransaction(pending.hash);
                }
            }
            throw new PendingTransaction(pending.hash, pending.lastLedger, { cause: error });
        }
    }
    success(receipt) {
        if (receipt.code !== 'tesSUCCESS')
            throw new LedgerFailure(receipt);
        return receipt;
    }
}
