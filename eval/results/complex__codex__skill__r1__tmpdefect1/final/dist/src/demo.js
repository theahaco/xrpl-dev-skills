import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { Client, Wallet, xrpToDrops } from 'xrpl';
import { FileStore, Transactions, MptIssuer, TESTNET, LedgerFailure, payment } from './index.js';
import { verify } from './verify.js';
const seed = process.env.ISSUER_SEED;
if (!seed)
    throw new Error('Set ISSUER_SEED in the environment');
const issuer = Wallet.fromSeed(seed);
assert.equal(issuer.classicAddress, 'rEhS5hFsARRniruZPfLauD2U1hrnt3RpnP');
mkdirSync('.private', { recursive: true, mode: 0o700 });
const lock = openSync('.private/demo.lock', 'wx', 0o600);
const client = new Client(TESTNET, { connectionTimeout: 20000, timeout: 20000 });
try {
    const store = new FileStore('.private/demo-state.json');
    const tx = new Transactions(client, store);
    await client.connect();
    const info = (await client.request({ command: 'server_info' })).result.info;
    assert.equal(info.network_id, 1, 'Must be testnet');
    console.log('Testnet reserves', info.validated_ledger);
    const wallets = Object.fromEntries(['A', 'B', 'C'].map(label => {
        let saved = store.get(`wallet:${label}`);
        if (!saved) {
            saved = Wallet.generate().seed;
            store.put(`wallet:${label}`, saved);
        }
        return [label, Wallet.fromSeed(saved)];
    }));
    const holders = { A: wallets.A.classicAddress, B: wallets.B.classicAddress, C: wallets.C.classicAddress };
    async function step(name, action) {
        if (store.get(`step:${name}`))
            return;
        await action();
        store.put(`step:${name}`, true);
        console.log(`PASS ${name}`);
    }
    const account = (await client.request({ command: 'account_info', account: issuer.classicAddress,
        ledger_index: 'validated' })).result.account_data;
    assert(BigInt(account.Balance) > BigInt(xrpToDrops('20')), 'Insufficient demo XRP');
    for (const label of ['A', 'B', 'C']) {
        await step(`fund-${label}`, () => tx.submit(`fund-${label}`, { TransactionType: 'Payment',
            Account: issuer.classicAddress, Destination: holders[label], Amount: xrpToDrops('5') }, issuer));
    }
    const token = await MptIssuer.create(tx, issuer, 'create-issuance');
    store.put('issuanceId', token.issuanceId);
    console.log('Issuance', token.issuanceId);
    for (const label of ['A', 'B', 'C']) {
        await step(`opt-in-${label}`, () => tx.submit(`opt-in-${label}`, { TransactionType: 'MPTokenAuthorize',
            Account: holders[label], MPTokenIssuanceID: token.issuanceId }, wallets[label]));
    }
    async function blocked(name, source, destination, codes) {
        await step(name, async () => {
            try {
                await tx.submit(name, payment(source.classicAddress, destination, token.issuanceId, '1'), source);
            }
            catch (error) {
                if (!(error instanceof LedgerFailure) || !codes.includes(error.receipt.code))
                    throw error;
                store.put(`evidence:${name}`, error.receipt);
                console.log(`${name}: ${error.receipt.code} ${error.receipt.hash}`);
                return;
            }
            throw new Error(`Compliance failure: ${name} unexpectedly succeeded`);
        });
    }
    await blocked('unapproved-receive', issuer, holders.A, ['tecNO_AUTH']);
    for (const label of ['A', 'B', 'C']) {
        await step(`approve-${label}`, () => token.approve(holders[label], `approve-${label}`));
    }
    for (const [label, value] of [['A', '500'], ['B', '1000'], ['C', '200']]) {
        await step(`mint-${label}`, () => token.mint(holders[label], value, `mint-${label}`));
    }
    await step('clawback-B-300', () => token.clawback(holders.B, '300', 'clawback-B-300'));
    await step('freeze-A', () => token.setHolderFrozen(holders.A, true, 'freeze-A'));
    await blocked('frozen-A-send', wallets.A, holders.B, ['tecLOCKED']);
    await blocked('frozen-A-receive', wallets.B, holders.A, ['tecLOCKED']);
    await step('unfreeze-A', () => token.setHolderFrozen(holders.A, false, 'unfreeze-A'));
    await step('A-transfer-after-unfreeze', () => tx.submit('A-transfer-after-unfreeze', payment(holders.A, holders.C, token.issuanceId, '1'), wallets.A));
    await step('C-return-transfer', () => tx.submit('C-return-transfer', payment(holders.C, holders.A, token.issuanceId, '1'), wallets.C));
    await step('global-freeze', () => token.setGlobalFrozen(true, 'global-freeze'));
    await blocked('global-frozen-transfer', wallets.A, holders.B, ['tecLOCKED']);
    await step('global-unfreeze', () => token.setGlobalFrozen(false, 'global-unfreeze'));
    await step('A-transfer-after-global-unfreeze', () => tx.submit('A-transfer-after-global-unfreeze', payment(holders.A, holders.C, token.issuanceId, '1'), wallets.A));
    await step('C-return-after-global-unfreeze', () => tx.submit('C-return-after-global-unfreeze', payment(holders.C, holders.A, token.issuanceId, '1'), wallets.C));
    await step('freeze-B', () => token.setHolderFrozen(holders.B, true, 'freeze-B'));
    await blocked('frozen-B-send', wallets.B, holders.A, ['tecLOCKED']);
    await blocked('frozen-B-receive', wallets.A, holders.B, ['tecLOCKED']);
    await step('ban-C', () => token.ban(holders.C, 'ban-C'));
    await blocked('banned-C-receive', wallets.A, holders.C, ['tecNO_AUTH', 'tecLOCKED']);
    await blocked('banned-C-issuer-receive', issuer, holders.C, ['tecNO_AUTH', 'tecLOCKED']);
    await step('banned-C-reapproval-refused', async () => {
        await assert.rejects(token.approve(holders.C, 'must-not-approve-C'), /permanently banned/);
    });
    // Delete and recreate the holding to prove holder self-authorization cannot bypass the allowlist.
    await step('C-delete-holding', () => tx.submit('C-delete-holding', { TransactionType: 'MPTokenAuthorize',
        Account: holders.C, MPTokenIssuanceID: token.issuanceId, Flags: 1 }, wallets.C));
    await step('C-recreate-holding', () => tx.submit('C-recreate-holding', { TransactionType: 'MPTokenAuthorize',
        Account: holders.C, MPTokenIssuanceID: token.issuanceId }, wallets.C));
    await blocked('banned-C-recreated-receive', wallets.A, holders.C, ['tecNO_AUTH']);
    const result = { issuanceId: token.issuanceId, holders };
    const evidence = await verify(client, result);
    writeFileSync('verification.json', JSON.stringify(evidence, null, 2) + '\n');
    writeFileSync('audit.json', JSON.stringify(store.receipts(), null, 2) + '\n');
    writeFileSync('result.json.tmp', JSON.stringify(result, null, 2) + '\n');
    renameSync('result.json.tmp', 'result.json');
    console.log('Final state verified; result.json written');
}
finally {
    await client.disconnect();
    closeSync(lock);
    unlinkSync('.private/demo.lock');
}
