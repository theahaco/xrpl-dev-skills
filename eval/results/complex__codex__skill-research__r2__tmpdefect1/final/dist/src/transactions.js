import { createHash } from 'node:crypto';
import { SerialQueue } from './store.js';
export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export class LedgerFailure extends Error {
    receipt;
    constructor(receipt) {
        super(`${receipt.code}: ${receipt.hash}`);
        this.receipt = receipt;
    }
}
export class UnresolvedTransaction extends Error {
    hash;
    lastLedger;
    constructor(hash, lastLedger, options) {
        super(`Transaction ${hash} unresolved (LastLedgerSequence ${lastLedger}); reconcile or retry SAME operation ID. Do not create a replacement.`, options);
        this.hash = hash;
        this.lastLedger = lastLedger;
    }
}
export async function checkTestnet(client) {
    if (client.url !== TESTNET)
        throw new Error('Only the configured public testnet endpoint is allowed');
    const [server, features] = await Promise.all([
        client.request({ command: 'server_info' }), client.request({ command: 'feature' }),
    ]);
    if (server.result.info.network_id !== 1 || !server.result.info.validated_ledger || server.result.info.validated_ledger.age > 30) {
        throw new Error('Expected a fresh validated testnet ledger with network ID 1');
    }
    const required = ['MPTokensV1', 'Clawback', 'fixMPTDeliveredAmount'];
    for (const name of required) {
        if (!Object.values(features.result.features).some(f => f.name === name && f.enabled && f.supported)) {
            throw new Error(`Required amendment unavailable: ${name}`);
        }
    }
    return { server: server.result.info, features: features.result.features };
}
/** Persists signed bytes BEFORE submission. Same ID + same payload never signs twice. */
export class TransactionRunner {
    client;
    store;
    queue = new SerialQueue();
    controls = new Map();
    constructor(client, store) {
        this.client = client;
        this.store = store;
    }
    control(account, work) {
        let queue = this.controls.get(account);
        if (!queue) {
            queue = new SerialQueue();
            this.controls.set(account, queue);
        }
        return queue.run(work);
    }
    audit() {
        return this.store.entries('tx:').map(({ key, value }) => ({
            operationId: key.slice(3), hash: value.hash, lastLedger: value.lastLedger,
            ...(value.receipt ? { receipt: value.receipt } : {}),
        }));
    }
    send(id, tx, signer) {
        return this.queue.run(async () => {
            if (!id.trim() || tx.Account !== signer.classicAddress)
                throw new Error('Invalid operation ID or signer account');
            const fingerprint = createHash('sha256').update(JSON.stringify(tx)).digest('hex');
            const key = `tx:${id}`;
            let entry = this.store.get(key);
            if (entry && entry.fingerprint !== fingerprint)
                throw new Error(`Operation ID reused for a different payload: ${id}`);
            if (entry?.receipt)
                return this.success(entry.receipt);
            const pendingKey = `pending:${tx.Account}`;
            const pending = this.store.get(pendingKey);
            if (pending && pending !== id)
                throw new Error(`Account has unresolved operation ${pending}; reconcile it first`);
            await checkTestnet(this.client);
            if (!entry) {
                const prepared = await this.client.autofill(tx);
                if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 10000n)
                    throw new Error('Missing expiry or fee exceeds 0.01 XRP');
                const signed = await signer.sign(prepared);
                entry = { fingerprint, blob: signed.tx_blob, hash: signed.hash, lastLedger: prepared.LastLedgerSequence };
                this.store.putMany([[key, entry], [pendingKey, id]]);
            }
            this.store.put(pendingKey, id);
            const record = (result) => {
                if (result.validated !== true || !result.ledger_index || typeof result.meta !== 'object' || !result.meta || !('TransactionResult' in result.meta)) {
                    throw new Error('Expected validated transaction metadata');
                }
                const meta = result.meta;
                const receipt = { hash: result.hash, ledgerIndex: result.ledger_index, code: meta.TransactionResult, meta };
                if (result.hash !== entry?.hash)
                    throw new Error('Transaction hash mismatch');
                this.store.putMany([[key, { ...entry, receipt }], [pendingKey, null]]);
                return receipt;
            };
            let receipt;
            try {
                receipt = record((await this.client.submitAndWait(entry.blob)).result);
            }
            catch (error) {
                // Covers tefPAST_SEQ after a successful but interrupted submission, and SDK
                // errors for validated tec failures. Never rebuild a payment with a new sequence.
                try {
                    receipt = record((await this.client.request({ command: 'tx', transaction: entry.hash })).result);
                }
                catch {
                    throw new UnresolvedTransaction(entry.hash, entry.lastLedger, { cause: error });
                }
            }
            console.log(`${id}: ${receipt.code} ${receipt.hash}`);
            return this.success(receipt);
        });
    }
    success(receipt) {
        if (receipt.code !== 'tesSUCCESS')
            throw new LedgerFailure(receipt);
        return receipt;
    }
}
//# sourceMappingURL=transactions.js.map