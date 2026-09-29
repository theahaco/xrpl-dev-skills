import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Wallet } from 'xrpl';
import { amount, issuanceId, LedgerFailure, MptIssuer, TransactionRunner, walletSigner } from '../src/issuer.js';
import { FileStore } from '../src/store.js';
const id = '00000001' + 'A'.repeat(40);
const wallet = Wallet.generate();
const holder = Wallet.generate().classicAddress;
const memory = () => ({ state: { version: 1, transactions: {}, bans: {} }, save: async () => undefined });
test('amounts preserve full integer precision and reject malformed or out-of-range values', () => {
    assert.equal(amount('9223372036854775807'), '9223372036854775807');
    for (const value of ['0', '-1', '1.0', '1e3', '01', ' 1', '9223372036854775808', '']) {
        assert.throws(() => amount(value));
    }
    assert.equal(issuanceId(id.toLowerCase()), id);
    assert.throws(() => issuanceId('ABC'));
});
test('file store persists bans and rejects another writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mpt-test-'));
    try {
        const path = join(dir, 'state.json');
        const store = await FileStore.open(path);
        await assert.rejects(FileStore.open(path), { code: 'EEXIST' });
        store.state.bans[`${id}:${holder}`] = { reason: 'test', requestedAt: 'now' };
        await store.save();
        await store.close();
        const reopened = await FileStore.open(path);
        assert.equal(reopened.state.bans[`${id}:${holder}`]?.reason, 'test');
        await reopened.close();
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('banned address cannot be approved, issued to, or unfrozen, even in a new module instance', async () => {
    const store = memory();
    store.state.bans[`${id}:${holder}`] = { reason: 'test', requestedAt: 'now' };
    const issuer = new MptIssuer(new TransactionRunner(new Client('wss://example.com'), store), walletSigner(wallet), id);
    await assert.rejects(issuer.approve('approve', holder), /banned/);
    await assert.rejects(issuer.issue('issue', holder, '1'), /banned/);
    await assert.rejects(issuer.freeze('unfreeze', holder, false), /banned/);
});
test('queue serializes tasks and remains usable after a failure', async () => {
    const runner = new TransactionRunner(new Client('wss://example.com'), memory());
    const events = [];
    const first = runner.exclusive(async () => { events.push(1); await Promise.resolve(); events.push(2); throw new Error('test'); });
    const second = runner.exclusive(async () => { events.push(3); });
    await assert.rejects(first, /test/);
    await second;
    assert.deepEqual(events, [1, 2, 3]);
});
test('ban intent survives failure before the first ledger change', async () => {
    const store = memory();
    const runner = new TransactionRunner(new Client('wss://example.com'), store);
    const issuer = new MptIssuer(runner, walletSigner(wallet), id);
    issuer.assertConfiguration = async () => undefined;
    issuer.holder = async () => { throw new Error('network unavailable'); };
    await assert.rejects(issuer.ban('ban', holder, 'KYC revoked'), /network unavailable/);
    assert.equal(store.state.bans[`${id}:${holder}`]?.reason, 'KYC revoked');
});
test('transaction journal resumes identical bytes, rejects changed input, and records validated failures', async () => {
    const store = memory();
    let submits = 0;
    const client = new Client('wss://example.com');
    // Mock the network boundary only; exercise the real signing and journaling flow.
    Object.assign(client, {
        request: async () => { const error = new Error('not found'); Object.assign(error, { data: { error: 'txnNotFound' } }); throw error; },
        autofill: async (tx) => ({ ...tx, Sequence: 1, LastLedgerSequence: 100, Fee: '10' }),
        getLedgerIndex: async () => 10,
        submitAndWait: async (blob) => {
            submits++;
            assert.equal(blob, store.state.transactions.op?.blob, 'must persist before broadcast');
            return { result: { validated: true, hash: store.state.transactions.op?.hash, ledger_index: 11, meta: { TransactionResult: 'tecNO_AUTH' } } };
        },
    });
    const runner = new TransactionRunner(client, store);
    runner.checkNetwork = async () => undefined;
    const tx = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: holder, Amount: '1' };
    await assert.rejects(runner.submit('op', tx, walletSigner(wallet)), LedgerFailure);
    await assert.rejects(runner.submit('op', tx, walletSigner(wallet)), LedgerFailure);
    assert.equal(submits, 1);
    await assert.rejects(runner.submit('op', { ...tx, Amount: '2' }, walletSigner(wallet)), /different input/);
});
test('a pending transaction blocks new operations', async () => {
    const state = { version: 1, transactions: {
            pending: { fingerprint: 'x', blob: '00', hash: 'A'.repeat(64), lastLedgerSequence: 100 },
        }, bans: {} };
    const runner = new TransactionRunner(new Client('wss://example.com'), { state, save: async () => undefined });
    runner.checkNetwork = async () => undefined;
    await assert.rejects(runner.submit('new', { TransactionType: 'Payment', Account: wallet.classicAddress,
        Destination: holder, Amount: '1' }, walletSigner(wallet)), /Unresolved operation pending/);
});
test('issuance fails closed on holder/global freeze before reaching signer', async () => {
    const runner = new TransactionRunner(new Client('wss://example.com'), memory());
    const issuer = new MptIssuer(runner, walletSigner(wallet), id);
    issuer.assertConfiguration = async () => undefined;
    const base = { LedgerEntryType: 'MPTokenIssuance', Flags: 103, Issuer: wallet.classicAddress,
        Sequence: 1, OutstandingAmount: '1', OwnerNode: '0', PreviousTxnID: 'A'.repeat(64), PreviousTxnLgrSeq: 1, index: 'A'.repeat(64) };
    issuer.issuance = async () => base;
    issuer.holder = async () => ({ LedgerEntryType: 'MPToken', Flags: 2, MPTokenIssuanceID: id,
        MPTAmount: '1', PreviousTxnID: 'A'.repeat(64), PreviousTxnLgrSeq: 1, index: 'A'.repeat(64) });
    await assert.rejects(issuer.issue('global', holder, '1'), /frozen/);
    issuer.issuance = async () => ({ ...base, Flags: 102 });
    issuer.holder = async () => ({ LedgerEntryType: 'MPToken', Flags: 3, MPTokenIssuanceID: id,
        MPTAmount: '1', PreviousTxnID: 'A'.repeat(64), PreviousTxnLgrSeq: 1, index: 'A'.repeat(64) });
    await assert.rejects(issuer.issue('holder', holder, '1'), /frozen/);
});
test('zero holder balance omitted by rippled normalizes to zero; malformed balance is rejected', async () => {
    const client = new Client('wss://example.com');
    const runner = new TransactionRunner(client, memory());
    const issuer = new MptIssuer(runner, walletSigner(wallet), id);
    const node = { LedgerEntryType: 'MPToken', Flags: 0, MPTokenIssuanceID: id };
    Object.assign(client, { request: async () => ({ result: { validated: true, node } }) });
    assert.equal((await issuer.holder(holder))?.MPTAmount, '0');
    Object.assign(client, { request: async () => ({ result: { validated: true, node: { ...node, MPTAmount: '-1' } } }) });
    await assert.rejects(issuer.holder(holder), /Invalid holder/);
});
test('journal persistence failure prevents broadcast and halts the runner', async () => {
    const store = memory();
    store.save = async () => { throw new Error('disk full'); };
    const client = new Client('wss://example.com');
    let broadcasts = 0;
    Object.assign(client, {
        autofill: async (tx) => ({ ...tx, Sequence: 1, LastLedgerSequence: 100, Fee: '10' }),
        submitAndWait: async () => { broadcasts++; throw new Error('must not be called'); },
    });
    const runner = new TransactionRunner(client, store);
    runner.checkNetwork = async () => undefined;
    const tx = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: holder, Amount: '1' };
    await assert.rejects(runner.submit('disk', tx, walletSigner(wallet)), /disk full/);
    await assert.rejects(runner.submit('disk', tx, walletSigner(wallet)), /halted/);
    assert.equal(broadcasts, 0);
});
//# sourceMappingURL=issuer.test.js.map