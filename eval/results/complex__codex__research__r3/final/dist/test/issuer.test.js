import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Wallet } from 'xrpl';
import { amount, MAX_AMOUNT, ISSUANCE_FLAGS, payment, MptIssuer } from '../src/issuer.js';
import { Store } from '../src/store.js';
import { Ledger } from '../src/ledger.js';
test('amounts preserve integer precision and reject unsafe/noncanonical inputs', () => {
    assert.equal(amount(MAX_AMOUNT), MAX_AMOUNT);
    assert.equal(amount('9007199254740993'), '9007199254740993');
    for (const value of ['0', '-1', '1.5', '01', '1e3', ' 1', 'NaN', '9223372036854775808'])
        assert.throws(() => amount(value));
});
test('configuration enables controls and peer transfers, excludes escrow, trade, confidential balances', () => {
    assert.equal(ISSUANCE_FLAGS, 102);
    const a = Wallet.generate(), b = Wallet.generate();
    assert.deepEqual(payment(a.address, b.address, 'A'.repeat(48), MAX_AMOUNT).Amount, { mpt_issuance_id: 'A'.repeat(48), value: MAX_AMOUNT });
});
test('persistent ban survives restart and store excludes a second writer', () => {
    const dir = mkdtempSync(join(process.cwd(), '.test-'));
    try {
        const path = join(dir, 'store.sqlite');
        let store = new Store(path);
        assert.throws(() => new Store(path));
        store.ban('token', 'holder', 'case-123');
        store.close();
        store = new Store(path);
        assert(store.isBanned('token', 'holder'));
        store.close();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('journal replay never signs twice; key conflict and uncertain account fail closed', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.test-'));
    const store = new Store(join(dir, 'store.sqlite'));
    try {
        const wallet = Wallet.generate(), recipient = Wallet.generate();
        const ledger = new Ledger(new Client('wss://example.invalid'), store);
        const tx = payment(wallet.address, recipient.address, 'A'.repeat(48), '1');
        const receipt = { hash: 'B'.repeat(64), code: 'tesSUCCESS', ledger: 100 };
        store.prepare({ key: 'one', account: wallet.address, intent: JSON.stringify(tx), blob: 'unused', hash: receipt.hash });
        store.complete('one', receipt);
        assert.deepEqual(await ledger.submit('one', wallet, tx), receipt);
        assert.deepEqual(await ledger.reconcile('one'), receipt);
        await assert.rejects(ledger.reconcile('missing'), /Unknown operation key/);
        await assert.rejects(ledger.submit('one', wallet, { ...tx, Destination: wallet.address }), /different transaction/);
        store.prepare({ key: 'pending', account: wallet.address, intent: '{}', blob: 'unused', hash: 'C'.repeat(64) });
        await assert.rejects(ledger.submit('two', wallet, tx), /Outcome unresolved/);
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test('exclusive workflow queue preserves order and recovers from failure', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.test-'));
    const store = new Store(join(dir, 'store.sqlite'));
    try {
        const ledger = new Ledger(new Client('wss://example.invalid'), store);
        const trace = [];
        await Promise.allSettled([
            ledger.exclusive(async () => { trace.push('first'); await Promise.resolve(); trace.push('end'); throw new Error('expected'); }),
            ledger.exclusive(async () => { trace.push('second'); }),
        ]);
        assert.deepEqual(trace, ['first', 'end', 'second']);
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test('ban persists intent first, resumes after interruption, and prevents reapproval/unfreeze', async (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.test-'));
    const store = new Store(join(dir, 'store.sqlite'));
    try {
        const wallet = Wallet.generate(), holder = Wallet.generate().address, id = 'A'.repeat(48);
        const client = new Client('wss://example.invalid');
        t.mock.method(client, 'request', async () => ({ result: { validated: true, node: {
                    LedgerEntryType: 'MPTokenIssuance', Issuer: wallet.address, Flags: ISSUANCE_FLAGS, AssetScale: 0,
                } } }));
        const ledger = new Ledger(client, store);
        const issuer = await MptIssuer.attach(ledger, wallet, id);
        let flags = 2, balance = '123', interrupt = true;
        const calls = [];
        t.mock.method(issuer, 'holding', async () => ({ Flags: flags, MPTAmount: balance }));
        t.mock.method(ledger, 'submit', async (_key, _signer, tx) => {
            assert(store.isBanned(id, holder), 'policy intent must precede every ban transaction');
            calls.push(tx.TransactionType);
            if (tx.TransactionType === 'MPTokenIssuanceSet')
                flags |= 1;
            else if (tx.TransactionType === 'MPTokenAuthorize') {
                if (interrupt) {
                    interrupt = false;
                    throw new Error('transport interruption');
                }
                flags &= ~2;
            }
            else if (tx.TransactionType === 'Clawback') {
                assert.equal(flags, 1, 'revoke before clawback');
                assert.equal(tx.Amount?.value, MAX_AMOUNT);
                balance = '0';
            }
            return { hash: 'B'.repeat(64), code: 'tesSUCCESS', ledger: 100 };
        });
        await assert.rejects(issuer.ban(holder, 'case-123'), /transport interruption/);
        assert(store.isBanned(id, holder));
        await issuer.ban(holder, 'case-123');
        assert.deepEqual(calls, ['MPTokenIssuanceSet', 'MPTokenAuthorize', 'MPTokenAuthorize', 'Clawback']);
        assert.equal(balance, '0');
        assert.equal(flags & 2, 0);
        await assert.rejects(issuer.approve(holder, 'kyc-ref', 'approve'), /banned/);
        await assert.rejects(issuer.issue(holder, '1', 'issue'), /banned/);
        await assert.rejects(issuer.setHolderFreeze(holder, false, 'unlock'), /banned/);
        const count = calls.length;
        await issuer.ban(holder, 'case-123');
        assert.equal(calls.length, count, 'completed ban is idempotent');
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test('issuer payments reject individual/global locks and missing authorization before signing', async (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.test-'));
    const store = new Store(join(dir, 'store.sqlite'));
    try {
        const wallet = Wallet.generate(), holder = Wallet.generate().address;
        const client = new Client('wss://example.invalid');
        t.mock.method(client, 'request', async () => ({ result: { validated: true, node: {
                    LedgerEntryType: 'MPTokenIssuance', Issuer: wallet.address, Flags: ISSUANCE_FLAGS,
                } } }));
        t.mock.method(client, 'getLedgerIndex', async () => 123);
        const ledger = new Ledger(client, store);
        const issuer = await MptIssuer.attach(ledger, wallet, 'A'.repeat(48));
        let global = false, flags = 3, submissions = 0;
        t.mock.method(issuer, 'issuance', async (index) => {
            assert.equal(index, 123);
            return { Flags: ISSUANCE_FLAGS | (global ? 1 : 0) };
        });
        t.mock.method(issuer, 'holding', async (_holder, index) => {
            assert.equal(index, 123);
            return { Flags: flags };
        });
        t.mock.method(ledger, 'submit', async () => { submissions++; return {}; });
        await assert.rejects(issuer.issue(holder, '1', 'local-freeze'), /freeze policy/);
        flags = 2;
        global = true;
        await assert.rejects(issuer.issue(holder, '1', 'global-freeze'), /freeze policy/);
        flags = 0;
        global = false;
        await assert.rejects(issuer.issue(holder, '1', 'unauthorized'), /not approved/);
        assert.equal(submissions, 0);
        flags = 2;
        await issuer.issue(holder, '1', 'approved');
        assert.equal(submissions, 1);
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test('omitted default amounts in ledger JSON normalize to zero', async (t) => {
    const dir = mkdtempSync(join(process.cwd(), '.test-'));
    const store = new Store(join(dir, 'store.sqlite'));
    try {
        const wallet = Wallet.generate();
        const client = new Client('wss://example.invalid');
        t.mock.method(client, 'request', async (request) => ({ result: { validated: true,
                node: request.mptoken ? { LedgerEntryType: 'MPToken', Flags: 0 } : {
                    LedgerEntryType: 'MPTokenIssuance', Issuer: wallet.address, Flags: ISSUANCE_FLAGS,
                },
            } }));
        const issuer = await MptIssuer.attach(new Ledger(client, store), wallet, 'A'.repeat(48));
        assert.equal((await issuer.issuance()).OutstandingAmount, '0');
        assert.equal((await issuer.holding(Wallet.generate().address))?.MPTAmount, '0');
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=issuer.test.js.map