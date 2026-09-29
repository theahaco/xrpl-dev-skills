import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amount, normalizeHolding, MAX_AMOUNT, Issuer, Submitter } from '../src/issuer.js';
import { Client, Wallet } from 'xrpl';
test('integer amounts reject rounding, overflow, negatives and zero', () => {
    for (const invalid of ['0', '-1', '1.5', '01', '1e3', '', ' 1', (MAX_AMOUNT + 1n).toString()])
        assert.throws(() => amount(invalid));
    assert.equal(amount(MAX_AMOUNT.toString()), MAX_AMOUNT.toString());
});
test('ban revokes before clawback and remains idempotent', async () => {
    const holder = Wallet.generate().classicAddress;
    let banned = false;
    const store = { has: async () => banned, add: async () => { banned = true; } };
    const submitter = new Submitter(new Client('wss://s.altnet.rippletest.net:51233'), Wallet.generate(), { prepared: async () => { }, validated: async () => { } });
    const issuer = new Issuer(submitter, 'A'.repeat(48), store);
    let balance = '200', flags = 2;
    const calls = [];
    issuer.verifyConfiguration = async () => { };
    issuer.holding = async () => ({ LedgerEntryType: 'MPToken', MPTokenIssuanceID: issuer.issuanceId, MPTAmount: balance, Flags: flags, index: 'x', PreviousTxnID: 'x', PreviousTxnLgrSeq: 1 });
    submitter.submit = async (tx) => {
        assert(banned, 'intent must be durable before ledger changes');
        calls.push(tx.TransactionType);
        if (tx.TransactionType === 'MPTokenAuthorize')
            flags = 0;
        if (tx.TransactionType === 'Clawback') {
            assert.equal(flags, 0);
            balance = '0';
        }
        return { hash: 'x', ledger: 1, code: 'tesSUCCESS' };
    };
    await issuer.ban(holder);
    await issuer.ban(holder);
    assert.deepEqual(calls, ['MPTokenAuthorize', 'Clawback']);
    await assert.rejects(issuer.approve(holder), /banned/);
    await assert.rejects(issuer.freezeHolder(holder, false), /banned/);
});
test('partial ban failure keeps deny policy and can resume', async () => {
    const holder = Wallet.generate().classicAddress;
    let banned = false, flags = 2, balance = '20', fail = true;
    const submitter = new Submitter(new Client('wss://s.altnet.rippletest.net:51233'), Wallet.generate(), { prepared: async () => { }, validated: async () => { } });
    const issuer = new Issuer(submitter, 'B'.repeat(48), { has: async () => banned, add: async () => { banned = true; } });
    issuer.verifyConfiguration = async () => { };
    issuer.holding = async () => ({ LedgerEntryType: 'MPToken', MPTokenIssuanceID: issuer.issuanceId, MPTAmount: balance, Flags: flags, index: 'x', PreviousTxnID: 'x', PreviousTxnLgrSeq: 1 });
    submitter.submit = async (tx) => {
        if (tx.TransactionType === 'MPTokenAuthorize')
            flags = 0;
        if (tx.TransactionType === 'Clawback') {
            if (fail)
                throw new Error('unavailable');
            balance = '0';
        }
        return { hash: 'x', ledger: 1, code: 'tesSUCCESS' };
    };
    await assert.rejects(issuer.ban(holder), /unavailable/);
    assert(banned);
    assert.equal(flags, 0);
    fail = false;
    await issuer.ban(holder);
    assert.equal(balance, '0');
});
test('submission journals before broadcast and fails closed on an uncertain outcome', async () => {
    const wallet = Wallet.generate();
    const client = new Client('wss://s.altnet.rippletest.net:51233');
    const events = [];
    // Stub only the network boundary, exercising actual signing and queue behavior.
    Object.assign(client, {
        request: async () => ({ result: { info: { network_id: 1 } } }),
        autofill: async (tx) => ({ ...tx, Fee: '12', Sequence: 1, LastLedgerSequence: 100 }),
        submitAndWait: async () => { events.push('broadcast'); throw new Error('connection lost'); },
    });
    const s = new Submitter(client, wallet, { prepared: async () => { events.push('prepared'); }, validated: async () => { events.push('validated'); } });
    const tx = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: Wallet.generate().classicAddress, Amount: '1' };
    await assert.rejects(s.submit(tx), /connection lost/);
    await assert.rejects(s.submit(tx), /unresolved/);
    assert.deepEqual(events, ['prepared', 'broadcast']);
});
test('wrong network and excessive fees never reach signing journal or broadcast', async () => {
    const wallet = Wallet.generate();
    for (const [network, fee] of [[0, '12'], [1, '1001']]) {
        const client = new Client('wss://s.altnet.rippletest.net:51233');
        let touched = false;
        Object.assign(client, {
            request: async () => ({ result: { info: { network_id: network } } }),
            autofill: async (tx) => ({ ...tx, Fee: fee, Sequence: 1, LastLedgerSequence: 100 }),
            submitAndWait: async () => { touched = true; },
        });
        const s = new Submitter(client, wallet, { prepared: async () => { touched = true; }, validated: async () => { } });
        await assert.rejects(s.submit({ TransactionType: 'Payment', Account: wallet.classicAddress, Destination: Wallet.generate().classicAddress, Amount: '1' }), /testnet|safety/);
        assert.equal(touched, false);
    }
});
test('zero balance omitted by rippled is normalized', () => {
    const node = { LedgerEntryType: 'MPToken', Flags: 0, MPTokenIssuanceID: 'A'.repeat(48) };
    assert.equal(normalizeHolding(node).MPTAmount, '0');
    assert.throws(() => normalizeHolding({ ...node, MPTAmount: '-1' }));
});
