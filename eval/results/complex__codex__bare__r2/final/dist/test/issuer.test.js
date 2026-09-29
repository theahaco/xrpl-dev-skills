import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'xrpl';
import { amount, MptIssuer, MAX_AMOUNT, REQUIRED_FLAGS } from '../src/issuer.js';
const issuerAddress = Wallet.generate().classicAddress;
const holder = Wallet.generate().classicAddress;
const id = 'A'.repeat(48);
function fixture() {
    const calls = [];
    let balance = '200', flags = 2, failDrain = false;
    const banned = new Set();
    const bans = { has: async (i, h) => banned.has(`${i}:${h}`), add: async (i, h) => { banned.add(`${i}:${h}`); } };
    const ledger = {
        issuance: async () => ({ Issuer: issuerAddress, Flags: REQUIRED_FLAGS, AssetScale: 0 }),
        holding: async () => ({ MPTAmount: balance, Flags: flags }),
        send: async (_key, tx) => {
            calls.push(tx);
            if (tx.TransactionType === 'MPTokenAuthorize')
                flags = tx.Flags === 1 ? 0 : 2;
            if (tx.TransactionType === 'Clawback') {
                if (failDrain)
                    throw new Error('Network unavailable');
                balance = '0';
            }
            return { hash: 'test', ledgerIndex: 1, code: 'tesSUCCESS', meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [], TransactionIndex: 0 } };
        },
    };
    return { issuer: new MptIssuer(issuerAddress, id, ledger, bans), ledger, bans, calls, fail: (value) => { failDrain = value; } };
}
test('integer validation preserves precision and rejects malformed or out of range amounts', () => {
    for (const value of ['0', '-1', '1.5', '01', '1e3', ' 1', (BigInt(MAX_AMOUNT) + 1n).toString()])
        assert.throws(() => amount(value));
    assert.equal(amount(MAX_AMOUNT), MAX_AMOUNT);
    assert.equal(amount('9007199254740993'), '9007199254740993');
});
test('ban revokes before draining; rejects approval, mint and unlock thereafter', async () => {
    const f = fixture();
    await f.issuer.ban(holder, 'ban');
    assert.deepEqual(f.calls.map(t => t.TransactionType), ['MPTokenAuthorize', 'Clawback']);
    assert.equal(f.calls[0]?.Flags, 1);
    assert.deepEqual(f.calls[1]?.Amount, { mpt_issuance_id: id, value: MAX_AMOUNT });
    await assert.rejects(f.issuer.approve(holder, 'approve'), /banned/);
    await assert.rejects(f.issuer.mint(holder, '1', 'mint'), /banned/);
    await assert.rejects(f.issuer.unfreeze(holder, 'unlock'), /banned/);
});
test('interrupted ban remains denied and can resume after restart', async () => {
    const f = fixture();
    f.fail(true);
    await assert.rejects(f.issuer.ban(holder, 'ban'), /Network/);
    const restarted = new MptIssuer(issuerAddress, id, f.ledger, f.bans);
    await assert.rejects(restarted.approve(holder, 'approve'), /banned/);
    f.fail(false);
    await restarted.ban(holder, 'ban');
    assert.equal((await f.ledger.holding(id, holder))?.MPTAmount, '0');
});
test('queued approval cannot race past an earlier ban', async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.issuer.ban(holder, 'ban'), f.issuer.approve(holder, 'approve')]);
    assert.equal(results[0]?.status, 'fulfilled');
    assert.equal(results[1]?.status, 'rejected');
});
test('freeze uses holder field, global freeze omits it; clawback uses Holder', async () => {
    const f = fixture();
    await f.issuer.freeze(holder, 'freeze');
    await f.issuer.unfreeze(holder, 'unfreeze');
    await f.issuer.globalFreeze('global');
    await f.issuer.globalUnfreeze('unglobal');
    await f.issuer.clawback(holder, '300', 'claw');
    assert.deepEqual(f.calls.slice(0, 4).map(t => [t.Holder, t.Flags]), [[holder, 1], [holder, 2], [undefined, 1], [undefined, 2]]);
    assert.equal(f.calls[4]?.Holder, holder);
});
test('wrong issuer or unsafe capability flags fail closed', async () => {
    const f = fixture();
    f.ledger.issuance = async () => ({ Issuer: issuerAddress, Flags: REQUIRED_FLAGS | 8 });
    await assert.rejects(f.issuer.approve(holder, 'approve'), /policy/);
    assert.equal(f.calls.length, 0);
});
test('ban handles zero balances whose MPTAmount field is omitted by rippled', async () => {
    const f = fixture();
    f.ledger.holding = async () => ({ Flags: 0, LedgerEntryType: 'MPToken' });
    await f.issuer.ban(holder, 'empty-ban');
    assert.deepEqual(f.calls.map(t => t.TransactionType), ['MPTokenAuthorize']);
});
test('ban on a holder without an entry persists denial without submitting transactions', async () => {
    const f = fixture();
    f.ledger.holding = async () => undefined;
    await f.issuer.ban(holder, 'absent-ban');
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.issuer.approve(holder, 'approve'), /banned/);
});
