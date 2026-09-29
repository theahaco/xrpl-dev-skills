import assert from 'node:assert/strict';
import { Client, Wallet } from 'xrpl';
import { MptIssuer } from './issuer.js';
import { TESTNET, TransactionRunner, walletSigner, requireSuccess } from './ledger.js';
import { atomicJson, FileStore } from './store.js';
import { assertFinal, ISSUER } from './verify.js';
async function main() {
    const seed = process.env.ISSUER_SEED;
    if (!seed)
        throw new Error('Set ISSUER_SEED to the testnet issuer seed');
    const issuerWallet = Wallet.fromSeed(seed);
    if (issuerWallet.classicAddress !== ISSUER)
        throw new Error('Issuer seed/address mismatch');
    const store = new FileStore('.private');
    const client = new Client(TESTNET, { maxFeeXRP: '0.001', timeout: 20000 });
    try {
        await client.connect();
        const runner = new TransactionRunner(client, store);
        await runner.preflight();
        const signer = walletSigner(issuerWallet);
        const state = store.read('demo') ?? {
            seeds: { A: Wallet.generate().seed, B: Wallet.generate().seed, C: Wallet.generate().seed }, done: [],
        };
        store.write('demo', state);
        const wallets = { A: Wallet.fromSeed(state.seeds.A), B: Wallet.fromSeed(state.seeds.B), C: Wallet.fromSeed(state.seeds.C) };
        const holders = { A: wallets.A.classicAddress, B: wallets.B.classicAddress, C: wallets.C.classicAddress };
        const step = async (name, work) => {
            if (state.done.includes(name))
                return;
            console.log(`Demo: ${name}`);
            await work();
            state.done.push(name);
            store.write('demo', state);
        };
        for (const label of ['A', 'B', 'C']) {
            await step(`fund-${label}`, async () => {
                requireSuccess(await runner.submit(`fund-${label}`, { TransactionType: 'Payment', Account: ISSUER, Destination: holders[label], Amount: '10000000' }, signer));
            });
        }
        const issuer = state.issuanceId ? await MptIssuer.open(state.issuanceId, runner, signer, store) : await MptIssuer.create(runner, signer, store, 'create');
        state.issuanceId = issuer.id;
        store.write('demo', state);
        for (const label of ['A', 'B', 'C']) {
            await step(`enroll-${label}`, async () => { requireSuccess(await runner.submit(`enroll-${label}`, issuer.enrollment(holders[label]), walletSigner(wallets[label]))); });
        }
        const denied = async (key, tx, sender, expected) => {
            const receipt = await runner.submit(key, tx, sender);
            assert.ok(expected.includes(receipt.code), `${key}: expected ${expected.join('/')}, got ${receipt.code}`);
        };
        await step('reject-unapproved', () => denied('reject-unapproved', issuer.payment(ISSUER, holders.C, '1'), signer, ['tecNO_AUTH']));
        for (const label of ['A', 'B', 'C'])
            await step(`approve-${label}`, () => issuer.approve(holders[label], `approve-${label}`));
        await step('issue-A', () => issuer.issue(holders.A, '500', 'issue-A'));
        await step('issue-B', () => issuer.issue(holders.B, '1000', 'issue-B'));
        await step('issue-C', () => issuer.issue(holders.C, '100', 'issue-C'));
        await step('freeze-A', () => issuer.freezeHolder(holders.A, true, 'freeze-A'));
        await step('A-cannot-send', () => denied('A-cannot-send', issuer.payment(holders.A, holders.C, '1'), walletSigner(wallets.A), ['tecLOCKED']));
        await step('A-cannot-receive', () => denied('A-cannot-receive', issuer.payment(holders.C, holders.A, '1'), walletSigner(wallets.C), ['tecLOCKED']));
        await step('issuer-payment-bypasses-holder-lock', async () => {
            // Retain the original probe key for exactly-once recovery. The ledger proved
            // this attempted negative test succeeds: issuer payments bypass MPT locks.
            requireSuccess(await runner.submit('issuer-cannot-send-to-frozen-A', issuer.payment(ISSUER, holders.A, '1'), signer));
            await assert.rejects(issuer.issue(holders.A, '1', 'module-blocks-frozen-issuance'), /Issuance blocked/);
        });
        // Explicitly demonstrate the protocol limitation instead of claiming absolute freezes.
        await step('frozen-A-can-redeem', async () => { requireSuccess(await runner.submit('frozen-A-can-redeem', issuer.payment(holders.A, ISSUER, '1'), walletSigner(wallets.A))); });
        await step('unfreeze-A', () => issuer.freezeHolder(holders.A, false, 'unfreeze-A'));
        await step('clawback-B-300', async () => {
            await issuer.clawback(holders.B, '300', 'clawback-B-300');
            assert.equal((await issuer.inspect([holders.B])).holders[holders.B]?.MPTAmount, '700');
        });
        await step('freeze-B', () => issuer.freezeHolder(holders.B, true, 'freeze-B'));
        await step('global-freeze', () => issuer.freezeAll(true, 'global-freeze'));
        await step('global-blocks-transfer', () => denied('global-blocks-transfer', issuer.payment(holders.A, holders.C, '1'), walletSigner(wallets.A), ['tecLOCKED']));
        await step('issuer-payment-bypasses-global-lock', async () => {
            requireSuccess(await runner.submit('issuer-payment-bypasses-global-lock', issuer.payment(ISSUER, holders.C, '1'), signer));
            await assert.rejects(issuer.issue(holders.C, '1', 'module-blocks-global-issuance'), /Issuance blocked/);
        });
        await step('global-allows-redemption', async () => { requireSuccess(await runner.submit('global-allows-redemption', issuer.payment(holders.A, ISSUER, '1'), walletSigner(wallets.A))); });
        await step('global-unfreeze', () => issuer.freezeAll(false, 'global-unfreeze'));
        await step('restore-A-after-global-redemption', () => issuer.issue(holders.A, '1', 'restore-A-after-global-redemption'));
        await step('transfer-after-unfreeze', async () => { requireSuccess(await runner.submit('transfer-after-unfreeze', issuer.payment(holders.A, holders.C, '1'), walletSigner(wallets.A))); });
        await step('return-after-unfreeze', async () => { requireSuccess(await runner.submit('return-after-unfreeze', issuer.payment(holders.C, holders.A, '1'), walletSigner(wallets.C))); });
        await step('freeze-C-before-ban', () => issuer.freezeHolder(holders.C, true, 'freeze-C-before-ban'));
        await step('ban-C', () => issuer.ban(holders.C, 'Demo compliance ban'));
        await step('reject-C-from-holder', () => denied('reject-C-from-holder', issuer.payment(holders.A, holders.C, '1'), walletSigner(wallets.A), ['tecNO_AUTH', 'tecLOCKED']));
        await step('reject-C-from-issuer', () => denied('reject-C-from-issuer', issuer.payment(ISSUER, holders.C, '1'), signer, ['tecNO_AUTH', 'tecLOCKED']));
        await step('C-delete-empty-token', async () => { requireSuccess(await runner.submit('C-delete-empty-token', { ...issuer.enrollment(holders.C), Flags: 1 }, walletSigner(wallets.C))); });
        await step('C-reenroll', async () => { requireSuccess(await runner.submit('C-reenroll', issuer.enrollment(holders.C), walletSigner(wallets.C))); });
        await step('C-still-denied', () => denied('C-still-denied', issuer.payment(holders.A, holders.C, '1'), walletSigner(wallets.A), ['tecNO_AUTH']));
        await assert.rejects(issuer.approve(holders.C, 'must-not-reapprove-C'), /permanently banned/);
        await assert.rejects(issuer.issue(holders.C, '1', 'must-not-issue-C'), /permanently banned/);
        const reopened = await MptIssuer.open(issuer.id, runner, signer, store);
        assert.equal(reopened.isBanned(holders.C), true);
        await assert.rejects(reopened.approve(holders.C, 'must-not-reapprove-C-after-reopen'), /permanently banned/);
        const result = { issuanceId: issuer.id, holders };
        const final = await issuer.inspect(Object.values(holders));
        assertFinal(final, result);
        atomicJson('verification.json', final);
        atomicJson('result.json', result);
        // Publish receipts and metadata, never signed blobs or private keys.
        const journal = store.read('transactions') ?? {};
        atomicJson('demo-evidence.json', { completedAt: new Date().toISOString(), steps: state.done, transactions: Object.fromEntries(Object.entries(journal).map(([key, value]) => [key, value.receipt])), freezeLimitation: 'Native MPT locks permit payments involving the issuer in both directions. The module blocks issuance while locked; direct signed issuer payments bypass that policy. Successful demo transactions prove both exceptions.' });
        console.log(`Demo complete; verified ledger ${final.ledgerIndex}; result.json written.`);
    }
    finally {
        await client.disconnect();
        store.close();
    }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Demo failed'); process.exitCode = 1; });
