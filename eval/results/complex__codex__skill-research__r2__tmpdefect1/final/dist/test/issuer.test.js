import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, encode, decode } from 'xrpl';
import { amount, payment, MptIssuer, ISSUANCE_FLAGS, MAX_MPT, readHolder } from '../src/issuer.js';
import { Store } from '../src/store.js';
import { TransactionRunner, TESTNET, LedgerFailure, UnresolvedTransaction } from '../src/transactions.js';
const issuer = Wallet.generate(), holder = Wallet.generate();
const id = '00000001' + 'AB'.repeat(20);
function fixture() {
    const dir = mkdtempSync(join(process.cwd(), '.test-'));
    const store = new Store(join(dir, 'state.sqlite'));
    return { store, close() { store.close(); rmSync(dir, { recursive: true }); } };
}
function mockClient() {
    let submits = 0, signs = 0;
    let code = 'tesSUCCESS', uncertain = false;
    let signedHash = '';
    const client = {
        url: TESTNET,
        async request(request) {
            if (request.command === 'server_info')
                return { result: { info: { network_id: 1, validated_ledger: { age: 0 } } } };
            if (request.command === 'feature')
                return { result: { features: Object.fromEntries(['MPTokensV1', 'Clawback', 'fixMPTDeliveredAmount'].map(name => [name, { name, enabled: true, supported: true }])) } };
            throw new Error('not found');
        },
        async autofill(tx) { return { ...tx, Sequence: 1, Fee: '12', LastLedgerSequence: 20 }; },
        async submitAndWait() {
            submits++;
            if (uncertain)
                throw new Error('connection lost');
            return { result: { validated: true, ledger_index: 10, hash: signedHash, meta: { TransactionResult: code, AffectedNodes: [], TransactionIndex: 0 } } };
        },
    };
    return { client: client, signer: { classicAddress: issuer.classicAddress, sign(tx) { signs++; const signed = issuer.sign(tx); signedHash = signed.hash; return signed; } },
        counts: () => ({ submits, signs }), fail: (value) => { code = value; }, uncertain: (value) => { uncertain = value; } };
}
test('amounts reject fractional, unsafe and noncanonical inputs without floating point', () => {
    assert.equal(amount(MAX_MPT), MAX_MPT);
    for (const invalid of ['0', '-1', '1.1', '01', '1e3', '', ' 5', '9223372036854775808'])
        assert.throws(() => amount(invalid));
    assert.throws(() => amount(1));
});
test('MPT payment roundtrips using installed SDK and never enables partial payments', () => {
    const tx = payment(issuer.classicAddress, holder.classicAddress, id, '9007199254740993');
    const decoded = decode(encode(tx));
    assert.deepEqual(decoded.Amount, tx.Amount);
    assert.equal(tx.Flags, undefined);
    assert.throws(() => payment('invalid', holder.classicAddress, id, '1'));
});
test('transaction replay returns durable receipt, signs once, and rejects ID collisions', async () => {
    const f = fixture(), mock = mockClient();
    try {
        const runner = new TransactionRunner(mock.client, f.store);
        const tx = payment(issuer.classicAddress, holder.classicAddress, id, '1');
        const first = await runner.send('one', tx, mock.signer);
        const restarted = new TransactionRunner(mock.client, f.store);
        assert.deepEqual(await restarted.send('one', tx, mock.signer), first);
        assert.deepEqual(mock.counts(), { submits: 1, signs: 1 });
        await assert.rejects(runner.send('one', { ...tx, Destination: issuer.classicAddress }, mock.signer), /different payload/);
    }
    finally {
        f.close();
    }
});
test('validated failure is durable and not retried', async () => {
    const f = fixture(), mock = mockClient();
    mock.fail('tecNO_AUTH');
    try {
        const runner = new TransactionRunner(mock.client, f.store);
        const tx = payment(issuer.classicAddress, holder.classicAddress, id, '1');
        await assert.rejects(runner.send('one', tx, mock.signer), LedgerFailure);
        await assert.rejects(runner.send('one', tx, mock.signer), LedgerFailure);
        assert.deepEqual(mock.counts(), { submits: 1, signs: 1 });
    }
    finally {
        f.close();
    }
});
test('uncertain submission blocks replacements and retries identical signed bytes', async () => {
    const f = fixture(), mock = mockClient();
    mock.uncertain(true);
    try {
        const runner = new TransactionRunner(mock.client, f.store);
        const tx = payment(issuer.classicAddress, holder.classicAddress, id, '1');
        await assert.rejects(runner.send('one', tx, mock.signer), UnresolvedTransaction);
        await assert.rejects(runner.send('two', tx, mock.signer), /unresolved operation/);
        mock.uncertain(false);
        await runner.send('one', tx, mock.signer);
        assert.deepEqual(mock.counts(), { submits: 2, signs: 1 });
    }
    finally {
        f.close();
    }
});
test('ban tombstone survives mid-ban failure and restart; approval stays blocked', async () => {
    const f = fixture();
    let flags = 2, balance = '100', fail = true;
    const submitted = [];
    const client = { async request(req) {
            return { result: { validated: true, node: req.mpt_issuance ?
                        { LedgerEntryType: 'MPTokenIssuance', Issuer: issuer.classicAddress, Flags: ISSUANCE_FLAGS, AssetScale: 0 } :
                        { LedgerEntryType: 'MPToken', Flags: flags, MPTAmount: balance } } };
        } };
    const runner = { client, store: f.store, control(_account, work) { return work(); }, async send(_id, tx) {
            submitted.push(tx);
            if (tx.TransactionType === 'MPTokenAuthorize')
                flags = 0;
            if (tx.TransactionType === 'Clawback') {
                if (fail)
                    throw new Error('interrupted');
                balance = '0';
            }
        } };
    try {
        const service = await MptIssuer.open(id, issuer, runner, f.store);
        await assert.rejects(service.ban(holder.classicAddress, 'sanctions', 'ban'), /interrupted/);
        const restarted = await MptIssuer.open(id, issuer, runner, f.store);
        await assert.rejects(restarted.approve(holder.classicAddress, { reference: 'kyc', approvedBy: 'reviewer' }, 'approve'), /banned/);
        await assert.rejects(restarted.freezeHolder(holder.classicAddress, false, 'unlock'), /banned/);
        fail = false;
        await restarted.ban(holder.classicAddress, 'sanctions', 'ban');
        assert.equal(balance, '0');
        assert.equal(flags, 0);
        assert.deepEqual(submitted.map(tx => tx.TransactionType), ['MPTokenAuthorize', 'Clawback', 'MPTokenAuthorize', 'Clawback']);
        assert.equal(f.store.get(`ban:${id}:${holder.classicAddress}`)?.status, 'complete');
    }
    finally {
        f.close();
    }
});
test('omitted zero MPTAmount normalizes to zero; RPC errors do not turn into zero', async () => {
    const client = { async request() { return { result: { validated: true, node: { LedgerEntryType: 'MPToken', Flags: 0 } } }; } };
    assert.equal((await readHolder(client, id, holder.classicAddress))?.MPTAmount, '0');
    const broken = { async request() { throw new Error('network failure'); } };
    await assert.rejects(readHolder(broken, id, holder.classicAddress), /network failure/);
});
test('local state refuses concurrent writers', () => {
    const dir = mkdtempSync(join(process.cwd(), '.test-'));
    const path = join(dir, 'state.sqlite');
    const first = new Store(path);
    try {
        assert.throws(() => new Store(path), /EEXIST/);
    }
    finally {
        first.close();
        rmSync(dir, { recursive: true });
    }
});
//# sourceMappingURL=issuer.test.js.map