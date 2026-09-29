import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client, Wallet } from 'xrpl';
import { LedgerFailure, MptIssuer, TESTNET, TransactionRunner, walletSigner } from './issuer.js';
import { atomicJson, FileStore } from './store.js';
import { ISSUER_ADDRESS, verify } from './verify.js';
const client = new Client(TESTNET, { timeout: 30000, maxFeeXRP: '0.01' });
const store = await FileStore.open('.private/compliance.json');
try {
    const seed = process.env.ISSUER_SEED;
    if (!seed)
        throw new Error('Set ISSUER_SEED to the testnet issuer seed');
    const issuerWallet = Wallet.fromSeed(seed);
    assert.equal(issuerWallet.classicAddress, ISSUER_ADDRESS, 'Issuer seed/address mismatch');
    const signer = walletSigner(issuerWallet);
    let seeds;
    try {
        seeds = JSON.parse(await readFile('.private/holders.json', 'utf8'));
    }
    catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw error;
        seeds = { A: Wallet.generate().seed, B: Wallet.generate().seed, C: Wallet.generate().seed };
        await atomicJson('.private/holders.json', seeds);
    }
    const holders = { A: Wallet.fromSeed(seeds.A), B: Wallet.fromSeed(seeds.B), C: Wallet.fromSeed(seeds.C) };
    const runner = new TransactionRunner(client, store);
    await client.connect();
    await runner.checkNetwork();
    const features = await client.request({ command: 'feature' });
    await atomicJson('research/demo-features.json', { checkedAt: new Date().toISOString(), ...features });
    const step = async (label, action) => {
        console.log(label);
        return action();
    };
    const submit = (key, tx, wallet) => runner.exclusive(() => runner.submit(key, tx, walletSigner(wallet)));
    for (const [name, wallet] of Object.entries(holders)) {
        await step(`Fund ${name} with 10 test XRP`, () => submit(`fund:${name}`, {
            TransactionType: 'Payment', Account: signer.address, Destination: wallet.classicAddress, Amount: '10000000',
        }, issuerWallet));
    }
    const issuer = await step('Create regulated MPT issuance', () => MptIssuer.create(runner, signer, 'create'));
    const id = issuer.id;
    const pay = (key, from, to, value = '1') => submit(key, {
        TransactionType: 'Payment', Account: from.classicAddress, Destination: to.classicAddress,
        Amount: { mpt_issuance_id: id, value },
    }, from);
    const reject = async (label, action, codes) => {
        console.log(`Check rejection: ${label}`);
        try {
            await action();
        }
        catch (error) {
            if (error instanceof LedgerFailure && codes.includes(error.receipt.code))
                return;
            throw error;
        }
        throw new Error(`Forbidden transaction succeeded: ${label}`);
    };
    for (const [name, wallet] of Object.entries(holders)) {
        await step(`Holder ${name} opts in`, () => submit(`optin:${name}`, {
            TransactionType: 'MPTokenAuthorize', Account: wallet.classicAddress, MPTokenIssuanceID: id,
        }, wallet));
    }
    await reject('unapproved holder cannot receive issuance', () => pay('deny:unapproved', issuerWallet, holders.C), ['tecNO_AUTH']);
    for (const [name, wallet] of Object.entries(holders)) {
        await step(`Approve holder ${name} (demo KYC fixture)`, () => issuer.approve(`approve:${name}`, wallet.classicAddress));
    }
    await step('Issue 500 to A', () => issuer.issue('issue:A', holders.A.classicAddress, '500'));
    await step('Issue 1000 to B', () => issuer.issue('issue:B', holders.B.classicAddress, '1000'));
    await step('Issue 200 to C', () => issuer.issue('issue:C', holders.C.classicAddress, '200'));
    await step('Freeze A', () => issuer.freeze('freeze:A', holders.A.classicAddress, true));
    await reject('A cannot send to B while frozen', () => pay('deny:A:send', holders.A, holders.B), ['tecLOCKED']);
    await reject('A cannot receive from B while frozen', () => pay('deny:A:receive', holders.B, holders.A), ['tecLOCKED']);
    // Live testnet allows issuer endpoints through native locks. Record and compensate the probe.
    await step('Verify native lock permits issuer payment to A', () => pay('deny:A:issue', issuerWallet, holders.A));
    await step('Claw back the extra native-lock probe token from A', () => issuer.clawback('probe:A:compensate', holders.A.classicAddress, '1'));
    if (!store.state.transactions['unfreeze:A']?.receipt)
        await assert.rejects(issuer.issue('deny:A:module-issue', holders.A.classicAddress, '1'), /frozen/);
    await step('Document native lock redemption exception', () => pay('probe:A:redeem', holders.A, issuerWallet));
    await step('Restore the redemption probe token through native issuer exception', () => pay('probe:A:restore', issuerWallet, holders.A));
    await step('Unfreeze A', () => issuer.freeze('unfreeze:A', holders.A.classicAddress, false));
    await step('A sends 1 to B after unfreeze', () => pay('unfrozen:A:send', holders.A, holders.B));
    await step('B returns 1 to A after unfreeze', () => pay('unfrozen:A:receive', holders.B, holders.A));
    await step('Globally freeze issuance', () => issuer.globalFreeze('global:freeze', true));
    await reject('global freeze prevents A sending to B', () => pay('deny:global:send', holders.A, holders.B), ['tecLOCKED']);
    await reject('global freeze prevents B sending to A', () => pay('deny:global:receive', holders.B, holders.A), ['tecLOCKED']);
    if (!store.state.transactions['global:unfreeze']?.receipt)
        await assert.rejects(issuer.issue('deny:global:module-issue', holders.A.classicAddress, '1'), /frozen/);
    await step('Globally unfreeze issuance', () => issuer.globalFreeze('global:unfreeze', false));
    await step('Claw back 300 from B', () => issuer.clawback('clawback:B', holders.B.classicAddress, '300'));
    await step('Freeze B permanently for this demo', () => issuer.freeze('freeze:B', holders.B.classicAddress, true));
    await reject('B cannot send while frozen', () => pay('deny:B:send', holders.B, holders.A), ['tecLOCKED']);
    await reject('B cannot receive while frozen', () => pay('deny:B:receive', holders.A, holders.B), ['tecLOCKED']);
    await step('Ban C: lock, revoke authorization, claw back entire balance', () => issuer.ban('ban:C', holders.C.classicAddress, 'Demo compliance ban'));
    // On this testnet fixCleanup3_4_0 is disabled: an empty locked holding can be
    // deleted and recreated. RequireAuth must preserve the ban even after that reset.
    if (!features.result.features?.['98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76']?.enabled) {
        await step('C deletes its zero-balance holding', () => submit('C:reset:delete', {
            TransactionType: 'MPTokenAuthorize', Account: holders.C.classicAddress, MPTokenIssuanceID: id, Flags: 1,
        }, holders.C));
        await step('C opts in again without issuer approval', () => submit('C:reset:optin', {
            TransactionType: 'MPTokenAuthorize', Account: holders.C.classicAddress, MPTokenIssuanceID: id,
        }, holders.C));
        await reject('recreated C holding remains unauthorized', () => pay('deny:C:recreated', holders.A, holders.C), ['tecNO_AUTH']);
        await reject('issuer cannot pay recreated unauthorized C', () => pay('deny:C:recreated:issuer', issuerWallet, holders.C), ['tecNO_AUTH']);
    }
    await reject('C cannot receive from A after ban', () => pay('deny:C:receive', holders.A, holders.C), ['tecLOCKED', 'tecNO_AUTH']);
    await reject('C cannot receive from issuer after ban', () => pay('deny:C:issue', issuerWallet, holders.C), ['tecLOCKED', 'tecNO_AUTH']);
    await assert.rejects(issuer.approve('deny:C:approve', holders.C.classicAddress), /permanently banned/);
    await assert.rejects(issuer.freeze('deny:C:unlock', holders.C.classicAddress, false), /permanently banned/);
    // Prove final A remains usable without changing the requested net balances.
    await step('A redeems 1 after global unfreeze', () => pay('global:unfrozen:redeem', holders.A, issuerWallet));
    await step('Issuer restores 1 to A', () => issuer.issue('global:unfrozen:issue', holders.A.classicAddress, '1'));
    const result = { issuanceId: id, holders: {
            A: holders.A.classicAddress, B: holders.B.classicAddress, C: holders.C.classicAddress,
        } };
    const evidence = await verify(client, result);
    await atomicJson('verification.json', evidence);
    await atomicJson('transactions.json', Object.fromEntries(Object.entries(store.state.transactions).map(([key, entry]) => [key, entry.receipt])));
    await atomicJson('result.json', result);
    console.log(`Verified final state at ledger ${evidence.ledgerIndex}; result.json written.`);
}
finally {
    await client.disconnect();
    await store.close();
}
//# sourceMappingURL=demo.js.map