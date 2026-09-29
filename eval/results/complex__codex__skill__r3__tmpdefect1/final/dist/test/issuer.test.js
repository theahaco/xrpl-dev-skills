import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet, encode, decode } from 'xrpl';
import { amount, MAX_AMOUNT, ISSUANCE_FLAGS, createIssuanceTx, MptIssuer, paymentTx } from '../src/index.js';
class MemoryStore {
    data = new Map();
    async get(key) { return structuredClone(this.data.get(key)); }
    async put(key, value) { this.data.set(key, structuredClone(value)); }
}
const issuer = Wallet.generate().classicAddress;
const holder = Wallet.generate().classicAddress;
const id = 'A'.repeat(48);
test('integer bounds reject zero, fractions, signs, exponent notation and overflow', () => {
    for (const value of ['0', '-1', '1.5', '1e3', '01', '+1', ' 1', '9223372036854775808'])
        assert.throws(() => amount(value));
    assert.equal(amount(MAX_AMOUNT), MAX_AMOUNT);
    assert.equal(amount('500'), '500');
    assert.throws(() => amount(500));
});
test('backend refuses issuer mint while either holding or issuance is locked', async () => {
    const store = new MemoryStore();
    let issuanceFlags = ISSUANCE_FLAGS;
    let holderFlags = 3;
    let submits = 0;
    const runner = { address: issuer, async execute() { submits++; return { hash: '', ledgerIndex: 1, code: 'tesSUCCESS' }; } };
    const ledger = {
        async issuance() {
            return { LedgerEntryType: 'MPTokenIssuance', Flags: issuanceFlags, Issuer: issuer, Sequence: 1,
                OutstandingAmount: '0', OwnerNode: '0', PreviousTxnID: '', PreviousTxnLgrSeq: 1, index: '' };
        },
        async holding() {
            return { LedgerEntryType: 'MPToken', Flags: holderFlags, MPTAmount: '0', MPTokenIssuanceID: id,
                PreviousTxnID: '', PreviousTxnLgrSeq: 1, index: '' };
        },
    };
    const module = new MptIssuer(id, runner, ledger, store);
    await assert.rejects(module.mint(holder, '1', 'one'), /frozen/);
    holderFlags = 2;
    issuanceFlags |= 1;
    await assert.rejects(module.mint(holder, '1', 'two'), /frozen/);
    issuanceFlags = ISSUANCE_FLAGS;
    holderFlags = 0;
    await assert.rejects(module.mint(holder, '1', 'three'), /not authorized/);
    assert.equal(submits, 0);
});
test('MPT transactions serialize with authorization, lock, transfer and clawback capabilities', () => {
    const tx = createIssuanceTx(issuer, '1000000');
    assert.equal(tx.Flags, 102);
    assert.equal(tx.AssetScale, 0);
    assert.deepEqual(decode(encode(tx)), tx);
    const payment = paymentTx(id, issuer, holder, '500');
    assert.deepEqual(decode(encode(payment)), payment);
    assert.throws(() => paymentTx('bad', issuer, holder, '1'));
    assert.throws(() => paymentTx(id, 'bad', holder, '1'));
});
test('ban revokes before draining; pending ban survives process restart and blocks reapproval', async () => {
    const store = new MemoryStore();
    let balance = '250';
    let flags = 2;
    let failDrain = true;
    const calls = [];
    const receipts = new Map();
    const runner = { address: issuer, async execute(key, tx) {
            const receipt = receipts.get(key);
            if (receipt)
                return receipt;
            calls.push(tx);
            if (tx.TransactionType === 'MPTokenAuthorize')
                flags &= ~2;
            if (tx.TransactionType === 'MPTokenIssuanceSet')
                flags |= 1;
            if (tx.TransactionType === 'Clawback') {
                assert.equal(flags & 2, 0);
                assert.equal(flags & 1, 1);
                assert.equal(tx.Holder, holder);
                assert.equal(tx.Amount.value, MAX_AMOUNT);
                balance = '0';
                if (failDrain)
                    throw new Error('Connection lost after ledger execution');
            }
            const result = { hash: key, ledgerIndex: 1, code: 'tesSUCCESS' };
            receipts.set(key, result);
            return result;
        } };
    const ledger = {
        async issuance() {
            return { LedgerEntryType: 'MPTokenIssuance', Flags: ISSUANCE_FLAGS, Issuer: issuer, Sequence: 1,
                OutstandingAmount: balance, OwnerNode: '0', PreviousTxnID: '', PreviousTxnLgrSeq: 1, index: '' };
        },
        async holding() {
            return { LedgerEntryType: 'MPToken', Flags: flags, MPTAmount: balance, MPTokenIssuanceID: id,
                PreviousTxnID: '', PreviousTxnLgrSeq: 1, index: '' };
        },
    };
    let module = new MptIssuer(id, runner, ledger, store);
    await assert.rejects(module.ban(holder, 'ban-1', 'KYC revoked'), /Connection lost/);
    module = new MptIssuer(id, runner, ledger, store);
    await assert.rejects(module.approve(holder, 'approve'), /banned/);
    await assert.rejects(module.unfreezeHolder(holder, 'unlock'), /banned/);
    await assert.rejects(module.mint(holder, '1', 'mint'), /banned/);
    failDrain = false;
    await module.ban(holder, 'different-key', 'retry');
    assert.equal(balance, '0');
    assert.equal(flags, 1);
    assert.equal(calls.filter(t => t.TransactionType === 'Clawback').length, 2, 'Must reconcile prior drain even with zero balance');
    const count = calls.length;
    await module.ban(holder, 'another-key', 'retry');
    assert.equal(calls.length, count);
});
