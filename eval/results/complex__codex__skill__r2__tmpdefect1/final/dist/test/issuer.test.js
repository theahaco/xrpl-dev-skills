import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, decode } from 'xrpl';
import { amount, AUTHORIZED, CONTROL_FLAGS, Executor, LedgerFailure, MAX_AMOUNT, MptIssuer, SerialQueue, UncertainSubmission } from '../src/issuer.js';
const wallet = Wallet.generate();
const holder = Wallet.generate().classicAddress;
const id = '0'.repeat(48);
const tx = { TransactionType: 'MPTokenAuthorize', Account: wallet.classicAddress, MPTokenIssuanceID: id };
function fixture() {
    const sent = [];
    let balance = '100', authorized = true, frozen = false, global = false, banned = false;
    let submitError = false, resultCode = 'tesSUCCESS', fee = '12', network = 1, failClaw = false;
    const records = [];
    const journal = { async assertReady() { }, async prepared(r) { records.push(r); }, async settled() { } };
    const bans = { async isBanned() { return banned; }, async ban() { banned = true; } };
    const client = {
        async request(r) {
            if (r.command === 'server_info')
                return { result: { info: { network_id: network } } };
            if (r.mpt_issuance)
                return { result: { validated: true, node: { LedgerEntryType: 'MPTokenIssuance', Issuer: wallet.classicAddress, Flags: CONTROL_FLAGS | (global ? 1 : 0), AssetScale: 0 } } };
            return { result: { validated: true, node: { LedgerEntryType: 'MPToken', ...(balance === '0' ? {} : { MPTAmount: balance }), Flags: (authorized ? AUTHORIZED : 0) | (frozen ? 1 : 0) } } };
        },
        async autofill(t) { return { ...t, Fee: fee, Sequence: 1, LastLedgerSequence: 100 }; },
        async submitAndWait(blob) {
            assert.ok(records.some(r => r.blob === blob), 'journal must precede submission');
            if (submitError)
                throw new Error('disconnect');
            const t = decode(blob);
            sent.push(t);
            const code = t.TransactionType === 'Clawback' && failClaw ? 'tecNO_PERMISSION' : resultCode;
            if (code === 'tesSUCCESS') {
                if (t.TransactionType === 'MPTokenAuthorize')
                    authorized = t.Flags !== 1;
                if (t.TransactionType === 'Clawback')
                    balance = '0';
                if (t.TransactionType === 'MPTokenIssuanceSet') {
                    if (t.Holder)
                        frozen = t.Flags === 1;
                    else
                        global = t.Flags === 1;
                }
            }
            return { result: { validated: true, ledger_index: 99, meta: { TransactionResult: code } } };
        },
    };
    return { sent, records, bans, executor: new Executor(client, wallet, journal), setBalance(v) { balance = v; }, setSubmitError() { submitError = true; }, setResult(v) { resultCode = v; }, setFee(v) { fee = v; }, setNetwork(v) { network = v; }, setFailClaw(v) { failClaw = v; } };
}
test('integer amounts reject rounding, negative, zero and overflow', () => {
    for (const value of ['0', '-1', '1.5', '01', '1e3', 'NaN', '9223372036854775808'])
        assert.throws(() => amount(value));
    assert.equal(amount(MAX_AMOUNT), MAX_AMOUNT);
    assert.equal(amount('9007199254740993'), '9007199254740993');
});
test('queue serializes calls and continues after a rejection', async () => {
    const q = new SerialQueue(), order = [];
    const first = q.run(async () => { order.push(1); throw new Error('expected'); });
    const second = q.run(async () => { order.push(2); });
    await assert.rejects(first);
    await second;
    assert.deepEqual(order, [1, 2]);
});
test('ban persists, revokes before draining maximum, survives restart, refuses reapproval', async () => {
    const f = fixture(), issuer = await MptIssuer.open(f.executor, id, f.bans);
    await issuer.ban(holder);
    assert.deepEqual(f.sent.map(t => t.TransactionType), ['MPTokenAuthorize', 'Clawback']);
    const claw = f.sent[1];
    assert.ok(claw?.TransactionType === 'Clawback');
    assert.deepEqual(claw.Amount, { mpt_issuance_id: id, value: MAX_AMOUNT });
    assert.equal(claw.Holder, holder);
    await issuer.ban(holder);
    assert.equal(f.sent.length, 2);
    const reopened = await MptIssuer.open(f.executor, id, f.bans);
    await assert.rejects(reopened.approve(holder), /banned/);
    await assert.rejects(reopened.mint(holder, '1'), /banned/);
    await assert.rejects(reopened.unfreeze(holder), /banned/);
});
test('partial ban failure stays denied and resumes safely', async () => {
    const f = fixture(), issuer = await MptIssuer.open(f.executor, id, f.bans);
    f.setFailClaw(true);
    await assert.rejects(issuer.ban(holder), LedgerFailure);
    assert.equal((await issuer.holder(holder)).authorized, false);
    await assert.rejects(issuer.approve(holder), /banned/);
    f.setFailClaw(false);
    await issuer.ban(holder);
    assert.equal((await issuer.holder(holder)).balance, '0');
});
test('zero balance omitted by rippled parses correctly', async () => {
    const f = fixture();
    f.setBalance('0');
    const issuer = await MptIssuer.open(f.executor, id, f.bans);
    assert.equal((await issuer.holder(holder)).balance, '0');
    await issuer.ban(holder);
    assert.equal(f.sent.length, 1);
});
test('holder and global lock transaction scopes are distinct', async () => {
    const f = fixture(), issuer = await MptIssuer.open(f.executor, id, f.bans);
    await issuer.freeze(holder);
    assert.equal((await issuer.holder(holder)).frozen, true);
    await assert.rejects(issuer.mint(holder, '1'), /frozen/);
    await issuer.unfreeze(holder);
    await issuer.setGlobalFreeze(true);
    await assert.rejects(issuer.mint(holder, '1'), /frozen/);
    assert.equal('Holder' in f.sent[2], false);
    await issuer.setGlobalFreeze(false);
});
test('validated tec is a typed terminal failure', async () => {
    const f = fixture();
    f.setResult('tecNO_AUTH');
    await assert.rejects(f.executor.send(tx), LedgerFailure);
});
test('ambiguous submission halts executor without signing another transaction', async () => {
    const f = fixture();
    f.setSubmitError();
    await assert.rejects(f.executor.send(tx), UncertainSubmission);
    await assert.rejects(f.executor.send(tx), /halted/);
    assert.equal(f.records.length, 1);
});
test('fee ceiling and testnet identity checked before signing/submission', async () => {
    const f = fixture();
    f.setFee('10001');
    await assert.rejects(f.executor.send(tx), /fee/);
    f.setFee('12');
    f.setNetwork(0);
    await assert.rejects(f.executor.send(tx), /testnet/);
    assert.equal(f.records.length, 0);
});
test('wrong signer and malformed addresses fail before ledger mutation', async () => {
    const f = fixture(), issuer = await MptIssuer.open(f.executor, id, f.bans);
    await assert.rejects(f.executor.send({ ...tx, Account: holder }), /mismatch/);
    await assert.rejects(issuer.approve('bad'), /Invalid/);
    assert.throws(() => issuer.clawback(wallet.classicAddress, '1'), /Issuer/);
    assert.equal(f.sent.length, 0);
});
