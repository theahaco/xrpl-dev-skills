import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Wallet } from 'xrpl';
import { amount, CAPABILITIES, holderAddress, MAX_AMOUNT, MptIssuer } from '../src/issuer.js';
import { LedgerFailure, Transactions, UncertainSubmission } from '../src/transactions.js';
class MemoryStore {
    values = new Map();
    async get(key) { return structuredClone(this.values.get(key)); }
    async put(key, value) { this.values.set(key, structuredClone(value)); }
}
const issuer = Wallet.generate();
const holder = Wallet.generate();
const id = '00000001' + 'A'.repeat(40);
const receipt = { hash: 'A'.repeat(64), ledger: 10, code: 'tesSUCCESS', meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [] } };
test('amounts preserve integer precision and reject unsafe representations', () => {
    assert.equal(amount(MAX_AMOUNT.toString()), MAX_AMOUNT.toString());
    for (const value of ['0', '-1', '1.1', '1e3', '01', ' 1', (MAX_AMOUNT + 1n).toString()])
        assert.throws(() => amount(value));
    assert.throws(() => holderAddress(issuer.classicAddress, issuer.classicAddress));
    assert.throws(() => holderAddress('invalid', issuer.classicAddress));
});
function fixture() {
    const store = new MemoryStore();
    const calls = [];
    let state = { LedgerEntryType: 'MPToken', MPTAmount: '200', Flags: 2 };
    let failRevoke = false;
    const transport = {
        client: { request: async (req) => ({ result: { node: req.mpt_issuance ? { LedgerEntryType: 'MPTokenIssuance', Flags: CAPABILITIES, Issuer: issuer.classicAddress } : state } }) },
        submit: async (_operation, tx) => {
            calls.push(tx);
            if (tx.TransactionType === 'MPTokenAuthorize') {
                if (failRevoke)
                    throw new Error('revoke interrupted');
                state = { ...state, Flags: 0 };
            }
            if (tx.TransactionType === 'Clawback')
                state = { ...state, MPTAmount: '0' };
            return receipt;
        },
    };
    return { mpt: new MptIssuer(transport, issuer, id, store), calls, interrupt: () => { failRevoke = true; }, recover: () => { failRevoke = false; } };
}
test('ban persists policy, revokes before clawback, drains balance, blocks reapproval', async () => {
    const { mpt, calls } = fixture();
    await mpt.ban('ban', holder.classicAddress);
    assert.deepEqual(calls.map(tx => tx.TransactionType), ['MPTokenAuthorize', 'Clawback']);
    assert.deepEqual(calls[1], { TransactionType: 'Clawback', Account: issuer.classicAddress, Holder: holder.classicAddress, Amount: { mpt_issuance_id: id, value: MAX_AMOUNT.toString() } });
    await assert.rejects(mpt.approve('approve', holder.classicAddress), /banned/);
    await assert.rejects(mpt.mint('mint', holder.classicAddress, '1'), /banned/);
    await assert.rejects(mpt.freeze('unlock', holder.classicAddress, false), /banned/);
});
test('partial ban fails closed and can resume', async () => {
    const f = fixture();
    f.interrupt();
    await assert.rejects(f.mpt.ban('ban', holder.classicAddress), /interrupted/);
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.mpt.approve('approve', holder.classicAddress), /banned/);
    f.recover();
    await f.mpt.ban('ban', holder.classicAddress);
    assert.equal((await f.mpt.holding(holder.classicAddress))?.MPTAmount, '0');
});
test('native MPT transaction shapes and flags serialize with xrpl', async () => {
    const f = fixture();
    await f.mpt.freeze('freeze', holder.classicAddress, true);
    await f.mpt.freeze('unfreeze', holder.classicAddress, false);
    await f.mpt.globalFreeze('global', true);
    await f.mpt.mint('mint', holder.classicAddress, '500');
    assert.deepEqual(f.calls.slice(0, 3).map(tx => tx.Flags), [1, 2, 1]);
    assert.ok(!('Holder' in f.calls[2]));
    for (const tx of f.calls) {
        const signed = issuer.sign({ ...tx, Sequence: 1, Fee: '10', LastLedgerSequence: 100 });
        assert.match(signed.hash, /^[A-F0-9]{64}$/);
    }
});
function runnerFixture(code = 'tesSUCCESS') {
    const store = new MemoryStore();
    let sends = 0;
    let lost = false;
    let validated = false;
    const result = { validated: true, ledger_index: 10, meta: { ...receipt.meta, TransactionResult: code } };
    const client = {
        request: async (request) => {
            if (request.command === 'server_info')
                return { result: { info: { network_id: 1 } } };
            if (validated)
                return { result };
            throw { data: { error: 'txnNotFound' } };
        },
        autofill: async (tx) => ({ ...tx, Fee: '10', Sequence: 1, LastLedgerSequence: 100 }),
        submitAndWait: async () => {
            assert.equal(store.values.size, 1, 'journal must exist before submission');
            sends++;
            validated = true;
            if (lost)
                throw new Error('connection lost after validation');
            return { result };
        },
    };
    return { store, client, runner: new Transactions(client, store), sends: () => sends, loseResponse: () => { lost = true; } };
}
const payment = { TransactionType: 'Payment', Account: issuer.classicAddress, Destination: holder.classicAddress, Amount: '1' };
test('durable operation IDs prevent double submission and reject changed intent', async () => {
    const f = runnerFixture();
    await f.runner.submit('same', payment, issuer);
    await new Transactions(f.client, f.store).submit('same', payment, issuer);
    assert.equal(f.sends(), 1);
    await assert.rejects(f.runner.submit('same', { ...payment, Amount: '2' }, issuer), /different transaction/);
});
test('unknown outcome reconciles by hash after restart', async () => {
    const f = runnerFixture();
    f.loseResponse();
    await assert.rejects(f.runner.submit('same', payment, issuer), UncertainSubmission);
    const recovered = await new Transactions(f.client, f.store).submit('same', payment, issuer);
    assert.equal(recovered.code, 'tesSUCCESS');
    assert.equal(f.sends(), 1);
});
test('validated tec result is recorded and never reported as success', async () => {
    const f = runnerFixture('tecNO_AUTH');
    await assert.rejects(f.runner.submit('same', payment, issuer), LedgerFailure);
    await assert.rejects(f.runner.submit('same', payment, issuer), LedgerFailure);
    assert.equal(f.sends(), 1);
});
test('ban and concurrent approval are serialized across the entire workflow', async () => {
    const f = fixture();
    const outcomes = await Promise.allSettled([f.mpt.ban('ban', holder.classicAddress), f.mpt.approve('approve', holder.classicAddress)]);
    assert.equal(outcomes[0]?.status, 'fulfilled');
    assert.equal(outcomes[1]?.status, 'rejected');
    assert.deepEqual(f.calls.map(tx => tx.TransactionType), ['MPTokenAuthorize', 'Clawback']);
});
test('network mismatch prevents submission, including journal replay', async () => {
    const f = runnerFixture();
    await f.runner.submit('same', payment, issuer);
    const wrongNetwork = { request: async () => ({ result: { info: { network_id: 0 } } }) };
    await assert.rejects(new Transactions(wrongNetwork, f.store).submit('same', payment, issuer), /Only XRPL testnet/);
});
test('ledger omits MPTAmount for a zero holding; malformed balances fail closed', async () => {
    let node = { LedgerEntryType: 'MPToken', Flags: 0 };
    const transport = { client: { request: async () => ({ result: { node } }) } };
    const mpt = new MptIssuer(transport, issuer, id, new MemoryStore());
    assert.equal((await mpt.holding(holder.classicAddress))?.MPTAmount, '0');
    node = { ...node, MPTAmount: '-1' };
    await assert.rejects(mpt.holding(holder.classicAddress), /Invalid ledger balance/);
});
