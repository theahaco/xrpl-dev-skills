import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, Wallet } from 'xrpl';
import { Store } from '../src/store.js';
import { Submitter, LedgerFailure } from '../src/submitter.js';
import { amount, MAX_AMOUNT, MptIssuer, issuanceID } from '../src/issuer.js';
test('amount validation preserves integer precision and rejects coercions', () => {
    for (const valid of ['1', '500', '9007199254740993', MAX_AMOUNT])
        assert.equal(amount(valid), valid);
    for (const invalid of ['0', '-1', '1.5', '1e3', '01', ' 1', '1 ', 'NaN', '9223372036854775808'])
        assert.throws(() => amount(invalid));
});
test('durable ban survives restart and prevents approval, issuance, and unfreeze', async () => {
    const dir = mkdtempSync(resolve('.private/test-'));
    const issuerWallet = Wallet.generate(), holder = Wallet.generate().classicAddress;
    const id = issuanceID(1, issuerWallet.classicAddress);
    let store = new Store(`${dir}/db`);
    store.ban(id, holder, 'test');
    store.close();
    store = new Store(`${dir}/db`);
    try {
        const issuer = new MptIssuer(new Submitter(new Client('wss://example.invalid'), store), issuerWallet, id);
        await assert.rejects(issuer.approve(holder, 'a'), /banned/);
        await assert.rejects(issuer.issue(holder, '1', 'b'), /banned/);
        await assert.rejects(issuer.freezeHolder(holder, false, 'c'), /banned/);
        assert.throws(() => new Store(`${dir}/db`), /EEXIST/);
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true });
    }
});
test('journal reconciles a lost response without signing or paying twice', async () => {
    const dir = mkdtempSync(resolve('.private/test-'));
    const store = new Store(`${dir}/db`);
    const wallet = Wallet.generate();
    let fills = 0, submits = 0, validated = false;
    const response = { result: { validated: true, ledger_index: 11, meta: { TransactionResult: 'tesSUCCESS' } } };
    const client = {
        autofill: async (tx) => { fills++; return { ...tx, Sequence: 1, Fee: '12', LastLedgerSequence: 30 }; },
        request: async () => { if (validated)
            return response; throw { data: { error: 'txnNotFound' } }; },
        submitAndWait: async () => { submits++; validated = true; throw new Error('socket closed after ledger validation'); },
    };
    const s = new Submitter(client, store);
    const tx = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: Wallet.generate().classicAddress, Amount: '100' };
    try {
        await assert.rejects(s.send('pay', tx, wallet), /Unresolved operation/);
        await assert.rejects(s.send('different', tx, wallet), /Reconcile pending/);
        const receipt = await s.send('pay', tx, wallet);
        assert.equal(receipt.code, 'tesSUCCESS');
        assert.equal(fills, 1);
        assert.equal(submits, 1);
        assert.deepEqual(await s.send('pay', tx, wallet), receipt);
        await assert.rejects(s.send('pay', { ...tx, Amount: '101' }, wallet), /different intent/);
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true });
    }
});
test('validated ledger failures are durable and are never retried as new transactions', async () => {
    const dir = mkdtempSync(resolve('.private/test-'));
    const store = new Store(`${dir}/db`);
    const wallet = Wallet.generate();
    let submits = 0;
    const client = {
        autofill: async (tx) => ({ ...tx, Sequence: 1, Fee: '12', LastLedgerSequence: 30 }),
        request: async () => { throw { data: { error: 'txnNotFound' } }; },
        submitAndWait: async () => { submits++; return { result: { validated: true, ledger_index: 11, meta: { TransactionResult: 'tecNO_AUTH' } } }; },
    };
    const s = new Submitter(client, store);
    const tx = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: Wallet.generate().classicAddress, Amount: '1' };
    try {
        await assert.rejects(s.send('denied', tx, wallet), LedgerFailure);
        await assert.rejects(s.send('denied', tx, wallet), LedgerFailure);
        assert.equal(submits, 1);
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true });
    }
});
test('exclusive queue continues after rejection without overlapping operations', async () => {
    const dir = mkdtempSync(resolve('.private/test-'));
    const store = new Store(`${dir}/db`);
    const s = new Submitter(new Client('wss://example.invalid'), store);
    const trace = [];
    try {
        const a = s.exclusive(async () => { trace.push(1); await Promise.resolve(); trace.push(2); throw new Error('failure'); });
        const b = s.exclusive(async () => { trace.push(3); });
        await Promise.allSettled([a, b]);
        assert.deepEqual(trace, [1, 2, 3]);
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true });
    }
});
test('ban fails closed and resumes after revocation but before draining', async () => {
    const dir = mkdtempSync(resolve('.private/test-'));
    const store = new Store(`${dir}/db`);
    const wallet = Wallet.generate(), holder = Wallet.generate().classicAddress, id = issuanceID(7, wallet.classicAddress);
    const s = new Submitter(new Client('wss://example.invalid'), store);
    const issuer = new MptIssuer(s, wallet, id);
    let balance = '200', flags = 2, fail = true;
    const trace = [];
    issuer.assertConfiguration = async () => { };
    issuer.holder = async () => ({ LedgerEntryType: 'MPToken', Account: holder, MPTokenIssuanceID: id, MPTAmount: balance, Flags: flags });
    s.send = async (op, tx) => {
        trace.push(tx.TransactionType);
        assert(store.isBanned(id, holder), 'Ban intent must precede every ledger transaction');
        if (tx.TransactionType === 'MPTokenIssuanceSet')
            flags |= 1;
        if (tx.TransactionType === 'MPTokenAuthorize')
            flags &= ~2;
        if (tx.TransactionType === 'Clawback') {
            if (fail) {
                fail = false;
                throw new Error('network failure');
            }
            balance = '0';
        }
        return { hash: op, ledger: 1, sequence: 1, code: 'tesSUCCESS' };
    };
    try {
        await assert.rejects(issuer.ban(holder, 'case', 'ban'), /network failure/);
        assert.equal(flags, 1);
        assert.equal(balance, '200');
        await assert.rejects(issuer.approve(holder, 'approve'), /banned/);
        await issuer.ban(holder, 'case', 'ban');
        assert.equal(balance, '0');
        assert.equal(flags, 1);
        assert.deepEqual(trace, ['MPTokenIssuanceSet', 'MPTokenAuthorize', 'Clawback', 'MPTokenIssuanceSet', 'MPTokenAuthorize', 'Clawback']);
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true });
    }
});
test('holder RPC accepts omitted zero balance but rejects mismatched identity', async () => {
    const dir = mkdtempSync(resolve('.private/test-'));
    const store = new Store(`${dir}/db`);
    const wallet = Wallet.generate(), holder = Wallet.generate().classicAddress, id = issuanceID(8, wallet.classicAddress);
    const node = { LedgerEntryType: 'MPToken', Account: holder, MPTokenIssuanceID: id, Flags: 0 };
    const client = { request: async () => ({ result: { validated: true, node } }) };
    const issuer = new MptIssuer(new Submitter(client, store), wallet, id);
    try {
        assert.equal((await issuer.holder(holder))?.MPTAmount, '0');
        node.Account = wallet.classicAddress;
        await assert.rejects(issuer.holder(holder), /Invalid holder response/);
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true });
    }
});
