import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Client, Wallet } from 'xrpl';
import { MptIssuer, holderOptIn } from './issuer.js';
import { LedgerFailure, Submitter, preflight, TESTNET } from './ledger.js';
import { Store } from './store.js';
import { ISSUER, verify } from './verify.js';
const seed = process.env.XRPL_ISSUER_SEED;
if (!seed)
    throw new Error('Set XRPL_ISSUER_SEED to the authorized testnet issuer seed');
const wallet = Wallet.fromSeed(seed);
assert.equal(wallet.classicAddress, ISSUER, 'Seed must match the authorized issuer');
const store = new Store('.private/demo.sqlite');
const client = new Client(TESTNET, { maxFeeXRP: '0.001', timeout: 20000 });
try {
    await client.connect();
    const network = await preflight(client);
    writeFileSync('research/runtime-preflight.json', JSON.stringify(network, null, 2) + '\n');
    const submitter = new Submitter(client, store);
    async function step(name, fn) {
        if (store.get(`step:${name}`))
            return;
        await fn();
        store.set(`step:${name}`, true);
    }
    const holders = Object.fromEntries(['A', 'B', 'C'].map(name => {
        let holderSeed = store.get(`wallet:${name}`);
        if (!holderSeed) {
            holderSeed = Wallet.generate().seed;
            store.set(`wallet:${name}`, holderSeed);
        }
        return [name, Wallet.fromSeed(holderSeed)];
    }));
    for (const name of ['A', 'B', 'C']) {
        await step(`fund:${name}`, async () => {
            const info = (await client.request({ command: 'server_info' })).result.info;
            const reserves = info.validated_ledger;
            if (!reserves || reserves.reserve_base_xrp + reserves.reserve_inc_xrp + 0.1 > 5)
                throw new Error('5 XRP funding no longer covers holder reserve');
            await submitter.submit(`fund:${name}`, { TransactionType: 'Payment', Account: ISSUER,
                Destination: holders[name].classicAddress, Amount: '5000000' }, wallet);
        });
    }
    const issuer = await MptIssuer.create(submitter, wallet, 'create');
    const result = { issuanceId: issuer.id, holders: { A: holders.A.classicAddress, B: holders.B.classicAddress, C: holders.C.classicAddress } };
    for (const name of ['A', 'B', 'C']) {
        await step(`opt-in:${name}`, () => submitter.submit(`opt-in:${name}`, holderOptIn(result.holders[name], issuer.id), holders[name]));
    }
    function payment(from, to, value = '1') {
        return { TransactionType: 'Payment', Account: from.classicAddress, Destination: to, Amount: { mpt_issuance_id: issuer.id, value } };
    }
    async function denied(key, from, to, codes) {
        await step(key, async () => {
            try {
                await submitter.submit(key, payment(from, to), from);
            }
            catch (error) {
                if (error instanceof LedgerFailure && codes.includes(error.receipt.code))
                    return;
                throw error;
            }
            throw new Error(`Compliance failure: ${key} unexpectedly succeeded`);
        });
    }
    await denied('unapproved:issuer-to-C', wallet, result.holders.C, ['tecNO_AUTH']);
    for (const name of ['A', 'B', 'C']) {
        await step(`approve:${name}`, () => issuer.approve(result.holders[name], `approve:${name}`));
    }
    await step('issue:A', () => issuer.issue(result.holders.A, '501', 'issue:A'));
    await step('issue:B', () => issuer.issue(result.holders.B, '1000', 'issue:B'));
    await step('issue:C', () => issuer.issue(result.holders.C, '201', 'issue:C'));
    await step('freeze:A', () => issuer.setHolderFreeze(result.holders.A, true, 'freeze:A'));
    await denied('frozen:A-to-B', holders.A, result.holders.B, ['tecLOCKED']);
    await denied('frozen:B-to-A', holders.B, result.holders.A, ['tecLOCKED']);
    await step('frozen:issuer-to-A', () => submitter.submit('frozen:issuer-to-A', payment(wallet, result.holders.A), wallet));
    await step('frozen:module-issuance-refused', async () => {
        await assert.rejects(issuer.issue(result.holders.A, '1', 'must-not-issue-frozen'), /freeze policy/);
    });
    // Explicitly demonstrate the native protocol exception instead of promising an absolute freeze.
    await step('frozen:redemption:A', () => submitter.submit('frozen:redemption:A', payment(holders.A, ISSUER), holders.A));
    await step('unfreeze:A', () => issuer.setHolderFreeze(result.holders.A, false, 'unfreeze:A'));
    await step('transfer:A-to-C', () => submitter.submit('transfer:A-to-C', payment(holders.A, result.holders.C), holders.A));
    await step('transfer:C-to-A', () => submitter.submit('transfer:C-to-A', payment(holders.C, result.holders.A), holders.C));
    await step('clawback:B:300', () => issuer.clawback(result.holders.B, '300', 'clawback:B:300'));
    await step('freeze:B', () => issuer.setHolderFreeze(result.holders.B, true, 'freeze:B'));
    await denied('frozen:B-to-C', holders.B, result.holders.C, ['tecLOCKED']);
    await denied('frozen:C-to-B', holders.C, result.holders.B, ['tecLOCKED']);
    await step('freeze:global', () => issuer.setGlobalFreeze(true, 'freeze:global'));
    await denied('global:A-to-C', holders.A, result.holders.C, ['tecLOCKED']);
    await step('global:issuer-to-A', () => submitter.submit('global:issuer-to-A', payment(wallet, result.holders.A), wallet));
    await step('global:module-issuance-refused', async () => {
        await assert.rejects(issuer.issue(result.holders.A, '1', 'must-not-issue-global'), /freeze policy/);
    });
    await step('global:redemption:C', () => submitter.submit('global:redemption:C', payment(holders.C, ISSUER), holders.C));
    await step('unfreeze:global', () => issuer.setGlobalFreeze(false, 'unfreeze:global'));
    await step('clawback:A:issuer-exceptions', () => issuer.clawback(result.holders.A, '2', 'clawback:A:issuer-exceptions'));
    await step('ban:C', () => issuer.ban(result.holders.C, 'ban:C'));
    await denied('banned:A-to-C', holders.A, result.holders.C, ['tecNO_AUTH']);
    await denied('banned:issuer-to-C', wallet, result.holders.C, ['tecNO_AUTH']);
    // Self-recreation must not restore issuer authorization.
    await step('banned:C:delete', () => submitter.submit('banned:C:delete', { ...holderOptIn(result.holders.C, issuer.id), Flags: 1 }, holders.C));
    await step('banned:C:recreate', () => submitter.submit('banned:C:recreate', holderOptIn(result.holders.C, issuer.id), holders.C));
    await denied('banned:recreated:A-to-C', holders.A, result.holders.C, ['tecNO_AUTH']);
    await step('banned:reapprove-refused', async () => {
        await assert.rejects(issuer.approve(result.holders.C, 'must-not-approve'), /permanently banned/);
        await assert.rejects(issuer.setHolderFreeze(result.holders.C, false, 'must-not-unfreeze'), /permanently banned/);
    });
    const verification = await verify(issuer, result);
    writeFileSync('result.json', JSON.stringify(result, null, 2) + '\n');
    writeFileSync('verification.json', JSON.stringify(verification, null, 2) + '\n');
    writeFileSync('demo-transactions.json', JSON.stringify(submitter.receipts(), null, 2) + '\n');
    console.log(`Demo complete; final state verified at ledger ${verification.ledger}`);
}
finally {
    await client.disconnect();
    store.close();
}
