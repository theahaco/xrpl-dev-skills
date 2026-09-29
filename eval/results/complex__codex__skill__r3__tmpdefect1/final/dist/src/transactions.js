import { createHash } from 'node:crypto';
import { SerialQueue } from './store.js';
export class LedgerFailure extends Error {
    receipt;
    constructor(receipt) {
        super(`Validated ${receipt.code}: ${receipt.hash}`);
        this.receipt = receipt;
    }
}
export class UnresolvedTransaction extends Error {
    hash;
    constructor(hash, options) {
        super(`Transaction ${hash} is unresolved; reconcile this hash before issuing a replacement`, options);
        this.hash = hash;
    }
}
/** One shared runner per account. Durable idempotency keys must never be recycled. */
export class TransactionRunner {
    client;
    signer;
    store;
    maxFeeDrops;
    queue = new SerialQueue();
    address;
    constructor(client, signer, store, maxFeeDrops = 10000n) {
        this.client = client;
        this.signer = signer;
        this.store = store;
        this.maxFeeDrops = maxFeeDrops;
        this.address = signer.address;
    }
    execute(key, tx) {
        return this.queue.run(async () => {
            if (!key || tx.Account !== this.address)
                throw new Error('Invalid operation key or signing account');
            const network = (await this.client.request({ command: 'server_info' })).result.info.network_id;
            if (network !== 1)
                throw new Error('Restricted to XRPL testnet (network_id=1)');
            const slot = `tx:1:${this.address}:${key}`;
            const fingerprint = createHash('sha256').update(JSON.stringify(tx)).digest('hex');
            let pending = await this.store.get(slot);
            if (pending && pending.fingerprint !== fingerprint)
                throw new Error('Idempotency key reused with different transaction');
            if (!pending) {
                const active = await this.store.get(`active:${this.address}`);
                if (active && active !== slot)
                    throw new Error(`Reconcile pending operation ${active} first`);
                const prepared = await this.client.autofill(tx);
                if (!prepared.Fee || BigInt(prepared.Fee) > this.maxFeeDrops || !prepared.LastLedgerSequence) {
                    throw new Error('Fee cap or LastLedgerSequence check failed');
                }
                const signed = await this.signer.sign(prepared);
                pending = { fingerprint, blob: signed.tx_blob, hash: signed.hash, lastLedger: prepared.LastLedgerSequence };
                await this.store.put(slot, pending);
            }
            if (!pending.receipt) {
                await this.store.put(`active:${this.address}`, slot);
                let response;
                try {
                    try {
                        response = await this.client.request({ command: 'tx', transaction: pending.hash });
                    }
                    catch (error) {
                        if (error.data?.error !== 'txnNotFound')
                            throw error;
                        response = await this.client.submitAndWait(pending.blob);
                    }
                    if (!response.result.validated)
                        response = await this.client.submitAndWait(pending.blob);
                }
                catch (cause) {
                    throw new UnresolvedTransaction(pending.hash, { cause });
                }
                const meta = response.result.meta;
                if (response.result.hash !== pending.hash || !response.result.validated || !response.result.ledger_index || !meta || typeof meta === 'string') {
                    throw new UnresolvedTransaction(pending.hash);
                }
                const receipt = { hash: pending.hash, ledgerIndex: response.result.ledger_index, code: meta.TransactionResult };
                if ('mpt_issuance_id' in meta && typeof meta.mpt_issuance_id === 'string')
                    receipt.issuanceId = meta.mpt_issuance_id;
                pending.receipt = receipt;
                await this.store.put(slot, pending);
                await this.store.put(`active:${this.address}`, '');
            }
            if (await this.store.get(`active:${this.address}`) === slot)
                await this.store.put(`active:${this.address}`, '');
            if (pending.receipt.code !== 'tesSUCCESS')
                throw new LedgerFailure(pending.receipt);
            return pending.receipt;
        });
    }
}
