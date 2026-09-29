import { createHash } from 'node:crypto';
export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export const AMENDMENTS = '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4';
export function rpcError(error, code) {
    return typeof error === 'object' && error !== null && 'data' in error &&
        typeof error.data === 'object' && error.data !== null && 'error' in error.data && error.data.error === code;
}
export async function checkTestnet(client) {
    const info = await client.request({ command: 'server_info' });
    if (info.result.info.network_id !== 1)
        throw new Error('Refusing to operate outside XRPL testnet (network_id=1)');
    const result = await client.request({ command: 'ledger_entry', index: AMENDMENTS, ledger_index: 'validated' });
    const node = result.result.node;
    if (!result.result.validated || !node || node.LedgerEntryType !== 'Amendments')
        throw new Error('Unvalidated amendment snapshot');
    for (const name of ['MPTokensV1', 'Clawback', 'fixMPTDeliveredAmount']) {
        const id = createHash('sha512').update(name).digest('hex').slice(0, 64).toUpperCase();
        if (!node.Amendments?.includes(id))
            throw new Error(`Required amendment is disabled: ${name}`);
    }
    return result.result;
}
export class TransactionFailure extends Error {
    receipt;
    constructor(receipt) {
        super(`${receipt.code}: ${receipt.hash}`);
        this.receipt = receipt;
    }
}
export class UncertainTransaction extends Error {
    key;
    hash;
    constructor(key, hash, options) {
        super(`Outcome unresolved for ${key} (${hash}). Retry this SAME operation key; do not create a replacement.`, options);
        this.key = key;
        this.hash = hash;
    }
}
function receiptFrom(response) {
    const { result } = response;
    if (!result.validated || typeof result.meta !== 'object' || !result.ledger_index)
        throw new Error('Transaction is not final');
    const receipt = { hash: result.hash, code: result.meta.TransactionResult, ledger: result.ledger_index };
    if ('mpt_issuance_id' in result.meta && typeof result.meta.mpt_issuance_id === 'string')
        receipt.issuanceId = result.meta.mpt_issuance_id;
    return receipt;
}
/** All signing for an account must go through this single writer and journal. */
export class Ledger {
    client;
    store;
    tail = Promise.resolve();
    constructor(client, store) {
        this.client = client;
        this.store = store;
    }
    exclusive(fn) {
        const task = this.tail.then(fn);
        this.tail = task.catch(() => undefined);
        return task;
    }
    /** Resolve an already-signed operation even if subsequent policy changes forbid a new one. */
    reconcile(key) {
        return this.exclusive(async () => {
            const row = this.store.get(key);
            if (!row)
                throw new Error('Unknown operation key');
            return this.submit(key, {
                address: row.account,
                sign: () => { throw new Error('Reconciliation must never sign a new transaction'); },
            }, JSON.parse(row.intent));
        });
    }
    /** Call under exclusive() when a workflow contains several transactions. */
    async submit(key, signer, tx) {
        if (!key || key.length > 200)
            throw new Error('Invalid operation key');
        if (signer.address !== tx.Account)
            throw new Error('Signer/account mismatch');
        const intent = JSON.stringify(tx);
        let row = this.store.get(key);
        if (row && row.intent !== intent)
            throw new Error('Operation key reused with different transaction');
        if (!row) {
            const pending = this.store.pending(signer.address);
            if (pending)
                throw new UncertainTransaction(pending.key, pending.hash);
            await checkTestnet(this.client);
            const prepared = await this.client.autofill(tx);
            if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 1000n)
                throw new Error('Missing expiry or fee exceeds 0.001 XRP');
            const signed = await signer.sign(prepared);
            this.store.prepare({ key, account: signer.address, intent, blob: signed.tx_blob, hash: signed.hash });
            row = this.store.get(key);
        }
        let receipt;
        if (row.receipt)
            receipt = JSON.parse(row.receipt);
        else {
            await checkTestnet(this.client);
            // Query first: a previous process may have submitted successfully before crashing.
            let response;
            try {
                response = await this.client.request({ command: 'tx', transaction: row.hash });
            }
            catch (error) {
                if (!rpcError(error, 'txnNotFound'))
                    throw new UncertainTransaction(key, row.hash, { cause: error });
            }
            try {
                if (!response?.result.validated)
                    response = await this.client.submitAndWait(row.blob);
                receipt = receiptFrom(response);
            }
            catch (error) {
                // Fail closed. Never autofill/re-sign an ambiguous payment or clawback.
                throw new UncertainTransaction(key, row.hash, { cause: error });
            }
            this.store.complete(key, receipt);
            console.log(`${key}: ${receipt.code} (${receipt.hash})`);
        }
        if (receipt.code !== 'tesSUCCESS')
            throw new TransactionFailure(receipt);
        return receipt;
    }
}
//# sourceMappingURL=ledger.js.map