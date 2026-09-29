import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'xrpl';
import { Runtime, readJson } from '../src/runtime.js';
test('signed bytes are durable before broadcast; lost response recovers without a second payment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mpt-runtime-'));
    try {
        const wallet = Wallet.generate();
        let submissions = 0;
        let validated = false;
        const receipt = { result: { validated: true, hash: 'test', ledger_index: 10, meta: { TransactionResult: 'tesSUCCESS' } } };
        const client = {
            autofill: async (tx) => ({ ...tx, Fee: '12', Sequence: 1, LastLedgerSequence: 100 }),
            request: async () => {
                if (validated)
                    return receipt;
                throw { data: { error: 'txnNotFound' } };
            },
            submitAndWait: async (blob) => {
                submissions++;
                const journal = await readJson(join(directory, 'journal.json'));
                assert.equal(Object.values(journal.entries)[0].blob, blob);
                validated = true;
                throw new Error('lost response');
            },
        };
        // Structural transport double; exercise the real journal and recovery implementation.
        const runtime = Object.assign(Object.create(Runtime.prototype), { client, directory,
            journal: { entries: {} }, tail: Promise.resolve() });
        const tx = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: Wallet.generate().classicAddress, Amount: '10' };
        await assert.rejects(runtime.send('payment-1', tx, wallet), /lost response/);
        await assert.rejects(runtime.send('payment-2', tx, wallet), /Unresolved transaction/);
        await runtime.reconcilePending();
        await runtime.send('payment-1', tx, wallet);
        assert.equal(submissions, 1);
        await assert.rejects(runtime.send('payment-1', { ...tx, Amount: '11' }, wallet), /reused/);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
