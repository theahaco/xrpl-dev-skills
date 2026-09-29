export class LedgerFailure extends Error {
    receipt;
    constructor(receipt) {
        super(`Validated ${receipt.code}: ${receipt.hash}`);
        this.receipt = receipt;
    }
}
/** One instance per issuer worker, shared by every operation (including funding). */
export class Transactions {
    client;
    store;
    tail = Promise.resolve();
    constructor(client, store) {
        this.client = client;
        this.store = store;
    }
    /** Reconcile a previously broadcast operation without constructing a replacement. */
    resumePending(wallet) {
        const id = this.store.get(`pending:${wallet.classicAddress}`);
        if (!id)
            return Promise.resolve(undefined);
        const journal = this.store.get(`tx:${id}`);
        if (!journal)
            return Promise.reject(new Error('Pending operation journal is missing'));
        return this.submit(id, JSON.parse(journal.request), wallet);
    }
    submit(id, tx, wallet) {
        const job = this.tail.then(() => this.execute(id, tx, wallet));
        this.tail = job.catch(() => undefined);
        return job;
    }
    async execute(id, tx, wallet) {
        if (tx.Account !== wallet.classicAddress)
            throw new Error('Signer/account mismatch');
        if (!id)
            throw new Error('An idempotency key is required');
        const request = JSON.stringify(tx);
        const key = `tx:${id}`;
        let saved = this.store.get(key);
        if (saved && saved.request !== request)
            throw new Error('Idempotency key reused for different transaction');
        const pending = this.store.get(`pending:${tx.Account}`);
        if (pending && pending !== id)
            throw new Error(`Reconcile pending operation ${pending} first`);
        if (!saved) {
            const prepared = await this.client.autofill(tx);
            if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 1000n) {
                throw new Error('Missing expiry or fee exceeds 1000 drops');
            }
            const signed = wallet.sign(prepared);
            saved = { request, blob: signed.tx_blob, hash: signed.hash, lastLedger: prepared.LastLedgerSequence };
            // Write before broadcasting. Never re-sign an ambiguous transaction.
            this.store.put(key, saved);
        }
        if (!saved.receipt) {
            this.store.put(`pending:${tx.Account}`, id);
            let result;
            try {
                result = (await this.client.request({ command: 'tx', transaction: saved.hash })).result;
            }
            catch (error) {
                if (error.data?.error !== 'txnNotFound')
                    throw error;
            }
            if (!result?.validated) {
                // submitAndWait handles queued transactions; retries reuse exactly the saved blob.
                // Expiry / past sequence without a validated hash remains blocked for reconciliation.
                result = (await this.client.submitAndWait(saved.blob)).result;
            }
            if (result.validated !== true || typeof result.meta !== 'object' || !result.meta || !result.ledger_index) {
                throw new Error(`Unresolved transaction ${saved.hash}; retry the same operation ID`);
            }
            const receipt = { hash: saved.hash, ledger: result.ledger_index,
                code: result.meta.TransactionResult, meta: result.meta };
            saved = { ...saved, receipt };
            this.store.put(key, saved);
        }
        this.store.put(`pending:${tx.Account}`, null);
        const receipt = saved.receipt;
        if (receipt.code !== 'tesSUCCESS')
            throw new LedgerFailure(receipt);
        return receipt;
    }
}
