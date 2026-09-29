import { Client, Wallet, xrpToDrops, MPTokenAuthorizeFlags } from 'xrpl';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { Runner, Journal, TESTNET, TransactionFailure, invariant } from './runtime.js';
import { MptIssuer } from './issuer.js';
import { verify } from './verify.js';
const seed = process.env.ISSUER_SEED;
invariant(seed, 'Set ISSUER_SEED in the environment');
const issuerWallet = Wallet.fromSeed(seed);
invariant(issuerWallet.address === 'rhXcp3PUXhNiJ2bA5uchbKjn71BrKv9Vck', 'Wrong demo issuer');
mkdirSync('.private', { recursive: true, mode: 0o700 });
// Persist demo holder keys encrypted, so interrupted runs can continue without new accounts.
const vaultPath = '.private/holders.enc';
let seeds;
if (existsSync(vaultPath)) {
    const data = readFileSync(vaultPath);
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(seed, data.subarray(0, 16), 32), data.subarray(16, 28));
    decipher.setAuthTag(data.subarray(28, 44));
    seeds = JSON.parse(Buffer.concat([decipher.update(data.subarray(44)), decipher.final()]).toString());
}
else {
    seeds = Array.from({ length: 3 }, () => Wallet.generate().seed);
    const salt = randomBytes(16), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', scryptSync(seed, salt, 32), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(seeds)), cipher.final()]);
    writeFileSync(vaultPath, Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600, flag: 'wx' });
}
const [A, B, C] = seeds.map(s => Wallet.fromSeed(s));
invariant(A && B && C, 'Invalid holder vault');
const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
const journal = new Journal('.private/demo.sqlite');
const runner = new Runner(client, journal);
try {
    await client.connect();
    const preflight = await runner.preflight();
    writeFileSync('research/live-preflight.json', JSON.stringify(preflight, null, 2));
    console.log(`Testnet reserves: ${preflight.server.validated_ledger?.reserve_base_xrp} XRP base, ${preflight.server.validated_ledger?.reserve_inc_xrp} XRP/object; funding holders with 5 XRP each.`);
    const issuer = await MptIssuer.create(runner, issuerWallet, 'setup');
    const result = { issuanceId: issuer.issuanceId, holders: { A: A.address, B: B.address, C: C.address } };
    journal.set('result', result);
    async function step(name, action) {
        if (journal.get(`step/${name}`))
            return;
        await action();
        journal.set(`step/${name}`, true);
    }
    async function rejected(name, from, to, codes) {
        await step(name, async () => {
            try {
                await runner.execute(name, issuer.payment(from.address, to, '1'), from);
            }
            catch (error) {
                if (!(error instanceof TransactionFailure))
                    throw error;
                assert.ok(codes.includes(error.receipt.code), `Unexpected rejection ${error.receipt.code}`);
                return;
            }
            throw new Error(`${name}: payment unexpectedly succeeded`);
        });
    }
    for (const [label, wallet] of [['A', A], ['B', B], ['C', C]]) {
        await step(`fund-${label}`, async () => {
            await runner.execute(`fund-${label}`, { TransactionType: 'Payment', Account: issuerWallet.address, Destination: wallet.address, Amount: xrpToDrops('5') }, issuerWallet);
        });
        await step(`opt-in-${label}`, async () => {
            await runner.execute(`opt-in-${label}`, { TransactionType: 'MPTokenAuthorize', Account: wallet.address, MPTokenIssuanceID: issuer.issuanceId }, wallet);
        });
    }
    await rejected('unapproved-issuer-to-C', issuerWallet, C.address, ['tecNO_AUTH']);
    for (const [label, wallet] of [['A', A], ['B', B], ['C', C]]) {
        await step(`approve-${label}`, () => issuer.approve(wallet.address, `approve-${label}`));
        await step(`issue-${label}`, () => issuer.issue(wallet.address, label === 'A' ? '500' : label === 'B' ? '1000' : '200', `issue-${label}`));
    }
    // Successful peer transfers prove CanTransfer is usable, with net-zero balances.
    await step('A-to-B', async () => { await runner.execute('A-to-B', issuer.payment(A.address, B.address, '1'), A); });
    await step('B-to-A', async () => { await runner.execute('B-to-A', issuer.payment(B.address, A.address, '1'), B); });
    await step('freeze-A', () => issuer.freeze(A.address, true, 'freeze-A'));
    await rejected('frozen-A-out', A, B.address, ['tecLOCKED', 'tecPATH_DRY', 'tecPATH_PARTIAL']);
    await rejected('frozen-A-in', B, A.address, ['tecLOCKED', 'tecPATH_DRY', 'tecPATH_PARTIAL']);
    // The initial raw-ledger probe demonstrated the issuer exemption; undo it exactly once.
    await step('restore-raw-issuer-probe', async () => {
        if (journal.db.prepare('SELECT id FROM operations WHERE id=?').get('frozen-A-issuer-in')) {
            await issuer.clawback(A.address, '1', 'restore-raw-issuer-probe');
        }
    });
    await step('frozen-issuer-policy', async () => {
        await assert.rejects(issuer.issue(A.address, '1', 'blocked-frozen-issue'), /frozen/);
    });
    await rejected('frozen-A-redeem', A, issuerWallet.address, ['tecNO_PERMISSION']);
    await step('unfreeze-A', () => issuer.freeze(A.address, false, 'unfreeze-A'));
    await step('clawback-B', () => issuer.clawback(B.address, '300', 'clawback-B'));
    await step('freeze-B', () => issuer.freeze(B.address, true, 'freeze-B'));
    await step('global-freeze', () => issuer.globalFreeze(true, 'global-freeze'));
    await rejected('global-out', A, C.address, ['tecLOCKED', 'tecPATH_DRY', 'tecPATH_PARTIAL']);
    await step('global-issuer-policy', async () => {
        await assert.rejects(issuer.issue(A.address, '1', 'blocked-global-issue'), /globally frozen/);
    });
    await rejected('global-redeem', A, issuerWallet.address, ['tecNO_PERMISSION']);
    // Ban while globally frozen demonstrates clawback still works during an incident.
    await step('ban-C', () => issuer.ban(C.address, 'Demo compliance ban', 'ban-C'));
    await step('global-unfreeze', () => issuer.globalFreeze(false, 'global-unfreeze'));
    await rejected('banned-C-in', A, C.address, ['tecNO_AUTH', 'tecLOCKED']);
    await rejected('banned-C-issuer-in', issuerWallet, C.address, ['tecNO_AUTH', 'tecLOCKED']);
    await step('C-delete-holding', async () => {
        await runner.execute('C-delete-holding', { TransactionType: 'MPTokenAuthorize', Account: C.address, MPTokenIssuanceID: issuer.issuanceId, Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize }, C);
    });
    await step('C-recreate-holding', async () => {
        await runner.execute('C-recreate-holding', { TransactionType: 'MPTokenAuthorize', Account: C.address, MPTokenIssuanceID: issuer.issuanceId }, C);
    });
    await rejected('banned-C-recreated-in', A, C.address, ['tecNO_AUTH']);
    await rejected('banned-C-recreated-issuer-in', issuerWallet, C.address, ['tecNO_AUTH']);
    await assert.rejects(issuer.approve(C.address, 'forbidden-reapprove'), /banned/);
    await assert.rejects(issuer.freeze(C.address, false, 'forbidden-unfreeze'), /banned/);
    await step('ban-C-idempotent', () => issuer.ban(C.address, 'Demo compliance ban', 'ban-C-again'));
    await step('unfrozen-A-to-C-proof', async () => {
        // C is banned and B frozen, so prove A's unlocked state with a successful issuer top-up and clawback.
        await issuer.issue(A.address, '1', 'A-after-unfreeze-issue');
        await issuer.clawback(A.address, '1', 'A-after-unfreeze-clawback');
    });
    const evidence = await verify(runner, issuer, result.holders);
    writeFileSync('verification.json', JSON.stringify(evidence, null, 2) + '\n');
    writeFileSync('result.json', JSON.stringify(result, null, 2) + '\n');
    const transactions = journal.db.prepare('SELECT id, hash, receipt FROM operations ORDER BY rowid').all().map(row => ({ id: row.id, hash: row.hash, ...JSON.parse(String(row.receipt)) }));
    writeFileSync('transactions.json', JSON.stringify(transactions, null, 2) + '\n');
    console.log('Verified final ledger state; result.json written.');
}
finally {
    await client.disconnect();
    journal.close();
}
