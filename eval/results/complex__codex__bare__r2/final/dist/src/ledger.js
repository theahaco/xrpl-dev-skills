import { existsSync, mkdirSync, rmdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from 'xrpl';
import { readJson, writeJson } from './storage.js';
export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export class LedgerFailure extends Error {
    receipt;
    constructor(receipt) {
        super(`${receipt.code}: ${receipt.hash}`);
        this.receipt = receipt;
    }
}
/** Owns a durable journal and a process lock. All use of an issuer must share this writer. */
export class TestnetLedger {
    client;
    issuer;
    directory;
    tail = Promise.resolve();
    closed = false;
    constructor(client, issuer, directory) {
        this.client = client;
        this.issuer = issuer;
        this.directory = directory;
    }
    static async open(issuer, directory) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        mkdirSync(`${directory}/writer.lock`); // Fail closed if another writer or stale lock exists.
        const client = new Client(TESTNET, { maxFeeXRP: '0.01', timeout: 30_000 });
        try {
            await client.connect();
            const info = (await client.request({ command: 'server_info' })).result.info;
            if (info.network_id !== 1)
                throw new Error('Refusing non-testnet network');
            const ledger = new TestnetLedger(client, issuer, directory);
            await ledger.reconcilePending();
            return ledger;
        }
        catch (error) {
            await client.disconnect();
            rmdirSync(`${directory}/writer.lock`);
            throw error;
        }
    }
    async close() {
        this.closed = true;
        await this.tail;
        await this.client.disconnect();
        rmdirSync(`${this.directory}/writer.lock`);
    }
    send(key, tx) { return this.sendAs(key, tx, this.issuer); }
    sendAs(key, tx, signer) {
        if (this.closed)
            return Promise.reject(new Error('Ledger closed'));
        const result = this.tail.then(() => this.submit(key, tx, signer));
        this.tail = result.catch(() => undefined);
        return result;
    }
    async submit(key, tx, signer) {
        if (!key.trim())
            throw new Error('An idempotency key is required');
        if (tx.Account !== signer.classicAddress)
            throw new Error('Signer/account mismatch');
        const path = `${this.directory}/${createHash('sha256').update(key).digest('hex')}.json`;
        const intent = JSON.stringify(tx);
        let journal;
        if (existsSync(path)) {
            journal = readJson(path);
            if (journal.intent !== intent)
                throw new Error(`Idempotency key reused with different transaction: ${key}`);
        }
        else {
            // Do not advance past an unresolved submission, even with another operation key.
            for (const file of readdirSync(this.directory).filter(f => f.endsWith('.json'))) {
                const old = readJson(`${this.directory}/${file}`);
                if (!old.receipt)
                    throw new Error(`Unresolved transaction ${old.hash}; resume its original operation first`);
            }
            const prepared = await this.client.autofill(tx);
            if (!prepared.LastLedgerSequence || BigInt(prepared.Fee ?? '0') > 10000n)
                throw new Error('Unsafe fee/expiry');
            const signed = signer.sign(prepared);
            journal = { intent, blob: signed.tx_blob, hash: signed.hash };
            writeJson(path, journal); // Before broadcast, never persist seed.
        }
        await this.settle(journal, path);
        if (!journal.receipt)
            throw new Error('Missing receipt');
        if (journal.receipt.code !== 'tesSUCCESS')
            throw new LedgerFailure(journal.receipt);
        return journal.receipt;
    }
    async reconcilePending() {
        for (const file of readdirSync(this.directory).filter(f => f.endsWith('.json'))) {
            const path = `${this.directory}/${file}`;
            const journal = readJson(path);
            await this.settle(journal, path);
        }
    }
    async settle(journal, path) {
        if (!journal.receipt) {
            let result;
            try {
                result = (await this.client.request({ command: 'tx', transaction: journal.hash })).result;
            }
            catch (error) {
                if (!isRpcError(error, 'txnNotFound'))
                    throw error;
            }
            if (!result?.validated)
                result = (await this.client.submitAndWait(journal.blob)).result;
            if (!result.validated || typeof result.meta !== 'object' || !result.meta || !result.ledger_index) {
                throw new Error(`Unresolved transaction ${journal.hash}; do not submit a replacement`);
            }
            journal.receipt = { hash: journal.hash, ledgerIndex: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta };
            writeJson(path, journal);
            console.log(`${journal.receipt.code} ${journal.hash}`);
        }
    }
    async entry(request) {
        const response = await this.client.request({ ...request, command: 'ledger_entry', ledger_index: request.ledger_index ?? 'validated', binary: false });
        if (!response.result.validated)
            throw new Error('Unvalidated ledger read');
        return response.result.node;
    }
    async holding(id, holder) {
        try {
            const node = await this.entry({ mptoken: { mpt_issuance_id: id, account: holder } });
            if (node.LedgerEntryType !== 'MPToken')
                throw new Error('Wrong ledger entry');
            return { ...node, MPTAmount: node.MPTAmount ?? '0' };
        }
        catch (error) {
            if (isRpcError(error, 'entryNotFound'))
                return undefined;
            throw error;
        }
    }
    async issuance(id) {
        const node = await this.entry({ mpt_issuance: id });
        if (node.LedgerEntryType !== 'MPTokenIssuance')
            throw new Error('Wrong ledger entry');
        return node;
    }
}
export function isRpcError(error, code) {
    return typeof error === 'object' && error !== null && 'data' in error &&
        typeof error.data === 'object' && error.data !== null && 'error' in error.data && error.data.error === code;
}
