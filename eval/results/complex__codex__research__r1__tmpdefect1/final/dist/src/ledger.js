import { decode, hashes } from 'xrpl';
import { SerialQueue } from './store.js';
import { isDeepStrictEqual } from 'node:util';
export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export const AMENDMENTS_INDEX = '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4';
export const REQUIRED_AMENDMENTS = {
    MPTokensV1: '950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38',
    Clawback: '56B241D7A43D40354D02A9DC4C8DF5C7A1F930D92A9035C4E12291B3CA3E1C2B',
};
export const walletSigner = (wallet) => ({
    address: wallet.classicAddress,
    sign: async (transaction) => wallet.sign(transaction),
});
export class LedgerFailure extends Error {
    receipt;
    constructor(receipt) {
        super(`${receipt.code}: ${receipt.hash}`);
        this.receipt = receipt;
    }
}
export function requireSuccess(receipt) {
    if (receipt.code !== 'tesSUCCESS')
        throw new LedgerFailure(receipt);
    return receipt;
}
/** Fail-closed, idempotent submission. Never signs a replacement for an ambiguous transaction. */
export class TransactionRunner {
    client;
    store;
    queue = new SerialQueue();
    journal;
    constructor(client, store) {
        this.client = client;
        this.store = store;
        this.journal = store.read('transactions') ?? {};
    }
    hasOperation(key) { return Object.hasOwn(this.journal, key); }
    async preflight() {
        const info = (await this.client.request({ command: 'server_info' })).result.info;
        if (info.network_id !== 1)
            throw new Error(`Expected testnet network_id 1, got ${info.network_id}`);
        const response = await this.client.request({ command: 'ledger_entry', index: AMENDMENTS_INDEX, ledger_index: 'validated' });
        if (!response.result.validated || response.result.node.LedgerEntryType !== 'Amendments')
            throw new Error('Unvalidated amendment response');
        const active = response.result.node.Amendments ?? [];
        for (const [name, id] of Object.entries(REQUIRED_AMENDMENTS)) {
            if (!active.includes(id))
                throw new Error(`Required amendment disabled: ${name}`);
        }
        this.store.write('network', { checkedAt: new Date().toISOString(), info, amendments: response.result });
    }
    submit(key, transaction, signer) {
        return this.queue.run(async () => {
            if (!/^[a-zA-Z0-9_:/.-]{1,200}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key))
                throw new Error('Invalid operation key');
            if (transaction.Account !== signer.address)
                throw new Error('Signer/account mismatch');
            const intent = JSON.stringify(transaction);
            let pending = this.journal[key];
            if (pending && pending.intent !== intent)
                throw new Error(`Idempotency key reused with different transaction: ${key}`);
            if (pending?.receipt)
                return pending.receipt;
            if (!pending) {
                const ambiguous = Object.entries(this.journal).find(([, p]) => !p.receipt);
                if (ambiguous)
                    throw new Error(`Reconcile pending operation ${ambiguous[0]} (${ambiguous[1].hash}) before new work`);
                await this.preflight();
                const filled = await this.client.autofill(transaction);
                if (!filled.Fee || BigInt(filled.Fee) > 1000n)
                    throw new Error('Fee exceeds 1000-drop ceiling');
                const lastLedger = filled.LastLedgerSequence;
                if (!lastLedger)
                    throw new Error('Missing transaction expiry');
                const signed = await signer.sign(filled);
                if (hashes.hashSignedTx(signed.tx_blob) !== signed.hash)
                    throw new Error('Signer hash mismatch');
                // Verify the signing service did not alter the intended transaction.
                const decoded = decode(signed.tx_blob);
                for (const [field, value] of Object.entries(filled)) {
                    if (!isDeepStrictEqual(decoded[field], value))
                        throw new Error(`Signer changed ${field}`);
                }
                for (const field of Object.keys(decoded)) {
                    if (!(field in filled) && !['SigningPubKey', 'TxnSignature', 'Signers'].includes(field))
                        throw new Error(`Signer added ${field}`);
                }
                pending = { intent, blob: signed.tx_blob, hash: signed.hash, account: signer.address, lastLedger };
                this.journal[key] = pending;
                this.store.write('transactions', this.journal); // Before the first network submission.
            }
            try {
                const existing = await this.client.request({ command: 'tx', transaction: pending.hash });
                if (existing.result.validated)
                    return this.finish(pending, existing.result);
            }
            catch (error) {
                if (!isRpcError(error, 'txnNotFound'))
                    throw error;
            }
            // Expiry does not prove absence on a server with incomplete history. Require reconciliation.
            if ((await this.client.getLedgerIndex()) > pending.lastLedger)
                throw new Error(`Expired unresolved transaction ${pending.hash}; reconcile ledger history before proceeding`);
            const result = await this.client.submitAndWait(pending.blob);
            return this.finish(pending, result.result);
        });
    }
    finish(pending, result) {
        if (!result.validated || result.hash !== pending.hash || !result.ledger_index || !result.meta || typeof result.meta === 'string')
            throw new Error(`Unconfirmed transaction ${pending.hash}`);
        const receipt = { hash: pending.hash, ledgerIndex: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta };
        pending.receipt = receipt;
        this.store.write('transactions', this.journal);
        console.log(`${receipt.code} ${receipt.hash}`);
        return receipt;
    }
}
export function isRpcError(error, code) {
    return typeof error === 'object' && error !== null && 'data' in error &&
        typeof error.data === 'object' && error.data !== null && 'error' in error.data && error.data.error === code;
}
