import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amount, MAX_AMOUNT, TransactionRunner } from '../src/issuer.js';
import { Client, Wallet } from 'xrpl';
test('amounts preserve large integer precision and reject ambiguous values', () => {
    assert.equal(amount(MAX_AMOUNT.toString()), MAX_AMOUNT.toString());
    assert.equal(amount('9007199254740993'), '9007199254740993');
    for (const value of ['0', '-1', '1.0', '1e3', '01', ' 1', '', (MAX_AMOUNT + 1n).toString()])
        assert.throws(() => amount(value));
});
test('wrong network fails before signing or journaling', async () => {
    const client = new Client('wss://s.altnet.rippletest.net:51233');
    client.request = (async () => ({ result: { info: { network_id: 0 } } }));
    const wallet = Wallet.generate();
    const runner = new TransactionRunner(client, async () => assert.fail('Must not journal'));
    await assert.rejects(runner.submit(wallet, { TransactionType: 'MPTokenAuthorize', Account: wallet.classicAddress, MPTokenIssuanceID: '0'.repeat(48) }), /outside XRPL testnet/);
});
test('an ambiguous submit halts queued operations and preserves the signed hash', async () => {
    const client = new Client('wss://s.altnet.rippletest.net:51233');
    client.request = (async () => ({ result: { info: { network_id: 1 } } }));
    client.autofill = (async (tx) => ({ ...tx, Fee: '12', Sequence: 1, LastLedgerSequence: 100 }));
    let submissions = 0;
    client.submitAndWait = (async () => { submissions++; throw new Error('transport timeout'); });
    const events = [];
    const runner = new TransactionRunner(client, async (event) => { events.push(event.hash); });
    const wallet = Wallet.generate();
    const tx = { TransactionType: 'MPTokenAuthorize', Account: wallet.classicAddress, MPTokenIssuanceID: '0'.repeat(48) };
    await assert.rejects(runner.submit(wallet, tx), /transport timeout/);
    await assert.rejects(runner.submit(wallet, tx), /Runner halted/);
    assert.equal(submissions, 1);
    assert.match(events[0] ?? '', /^[A-F0-9]{64}$/);
});
import { MptIssuer, CAPABILITIES } from '../src/issuer.js';
test('ban persists policy, revokes before clawback, resumes and denies reapproval', async () => {
    const client = new Client('wss://s.altnet.rippletest.net:51233');
    const wallet = Wallet.generate(), holder = Wallet.generate().classicAddress;
    const id = 'A'.repeat(48), steps = [];
    let flags = 2, balance = '100', banned = false;
    client.request = (async (request) => ({ result: { validated: true, ledger_index: 10, account_objects: request.account === wallet.classicAddress ? [{ LedgerEntryType: 'MPTokenIssuance', Issuer: wallet.classicAddress, mpt_issuance_id: id, Flags: CAPABILITIES }] : [{ LedgerEntryType: 'MPToken', MPTokenIssuanceID: id, Flags: flags, ...(balance === '0' ? {} : { MPTAmount: balance }) }] } }));
    const runner = new TransactionRunner(client, async () => { });
    runner.submit = async (_wallet, tx) => {
        steps.push(tx.TransactionType);
        if (tx.TransactionType === 'MPTokenAuthorize')
            flags = 0;
        else if (tx.TransactionType === 'Clawback') {
            assert.equal(flags, 0);
            balance = '0';
        }
        else
            assert.fail('Unexpected transaction');
        return { hash: 'A'.repeat(64), meta: {}, ledger_index: 10 };
    };
    const policy = { async isBanned() { return banned; }, async ban() { steps.push('persist'); banned = true; } };
    const token = await MptIssuer.attach(runner, wallet, id, policy);
    await token.ban(holder);
    assert.deepEqual(steps, ['persist', 'MPTokenAuthorize', 'Clawback']);
    await token.ban(holder);
    assert.deepEqual(steps, ['persist', 'MPTokenAuthorize', 'Clawback', 'persist']);
    await assert.rejects(token.approve(holder), /banned/);
    await assert.rejects(token.unfreezeHolder(holder), /banned/);
    await assert.rejects(token.issue(holder, '1'), /banned/);
});
