import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'xrpl';
import { MptIssuer, CAPABILITIES, amount, MAX_AMOUNT, holderAddress } from '../src/issuer.js';
test('amounts preserve uint63 precision and reject ambiguous input', () => {
    for (const input of ['0', '-1', '1.1', '1e3', '01', ' 1', '', '9223372036854775808'])
        assert.throws(() => amount(input));
    assert.equal(amount(MAX_AMOUNT), '9223372036854775807');
    assert.equal(amount('9007199254740993'), '9007199254740993');
});
test('holder address validation excludes issuer and malformed accounts', () => {
    const issuer = Wallet.generate().classicAddress;
    assert.throws(() => holderAddress(issuer, issuer));
    assert.throws(() => holderAddress('bad', issuer));
});
test('ban persists before submission, resumes after failure, drains and refuses reapproval after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mpt-test-'));
    try {
        const issuerWallet = Wallet.generate();
        const holder = Wallet.generate().classicAddress;
        const signer = issuerWallet;
        let flags = 2, balance = '200', failRevoke = true, issuanceFlags = CAPABILITIES;
        const calls = [];
        const fake = {
            directory,
            run: (work) => work(),
            client: { request: async (r) => {
                    if (r.command === 'account_info')
                        return { result: { account_data: { Flags: 0x01000000 } } };
                    if (r.command === 'account_objects')
                        return { result: { account_objects: [] } };
                    if (r.mptoken)
                        return { result: { node: { LedgerEntryType: 'MPToken', Flags: flags, ...(balance === '0' ? {} : { MPTAmount: balance }) } } };
                    return { result: { node: { LedgerEntryType: 'MPTokenIssuance', Issuer: issuerWallet.classicAddress, Flags: issuanceFlags } } };
                } },
            send: async (_id, tx) => {
                calls.push(tx.TransactionType);
                if (tx.TransactionType === 'MPTokenIssuanceSet')
                    flags |= 1;
                if (tx.TransactionType === 'MPTokenAuthorize') {
                    if (failRevoke) {
                        failRevoke = false;
                        throw new Error('network interrupted');
                    }
                    flags &= ~2;
                }
                if (tx.TransactionType === 'Clawback') {
                    assert.equal(flags, 1);
                    balance = '0';
                }
            },
        };
        const id = 'A'.repeat(48);
        let module = await MptIssuer.attach(fake, signer, id);
        flags = 3;
        await assert.rejects(module.issue(holder, '1', 'frozen-issue'), /freeze policy/);
        flags = 2;
        issuanceFlags |= 1;
        await assert.rejects(module.issue(holder, '1', 'global-frozen-issue'), /freeze policy/);
        issuanceFlags = CAPABILITIES;
        assert.equal(calls.length, 0, 'No frozen issuance may reach the signer');
        await assert.rejects(module.ban(holder, 'case-1', 'ban-1'), /network interrupted/);
        assert.equal(balance, '200');
        assert.equal(flags, 3);
        assert.equal(await module.isBanned(holder), true);
        module = await MptIssuer.attach(fake, signer, id);
        await assert.rejects(module.approve(holder, 'approve-1'), /banned/);
        await assert.rejects(module.setHolderFreeze(holder, false, 'unlock-1'), /banned/);
        await module.ban(holder, 'case-1', 'ban-1');
        assert.equal(balance, '0');
        assert.equal(flags, 1);
        assert.deepEqual(calls.slice(-3), ['MPTokenIssuanceSet', 'MPTokenAuthorize', 'Clawback']);
        await module.ban(holder, 'case-1', 'ban-1');
        assert.equal(calls.filter(x => x === 'Clawback').length, 1);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
