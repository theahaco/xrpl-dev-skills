import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Client, Wallet, MPTokenAuthorizeFlags } from 'xrpl';
import { MptIssuer, preflight, readHolding, readIssuance, LOCKED } from './issuer.js';
import { FileStore, atomicJson } from './store.js';
import { Transactions, TransactionRejected } from './transactions.js';
import { ISSUER_ADDRESS, TESTNET_URL, verifyFinal } from './verification.js';
const seed = process.env.ISSUER_SEED;
if (!seed)
    throw new Error('Set ISSUER_SEED to the funded testnet issuer seed');
const issuerWallet = Wallet.fromSeed(seed);
if (issuerWallet.classicAddress !== ISSUER_ADDRESS)
    throw new Error('Issuer seed/address mismatch');
const store = new FileStore('.state', ISSUER_ADDRESS);
const client = new Client(TESTNET_URL, { maxFeeXRP: '0.001', timeout: 20000 });
try {
    await client.connect();
    atomicJson('research/live-preflight.json', await preflight(client));
    const secretsPath = '.state/holders.json';
    if (!existsSync(secretsPath)) {
        atomicJson(secretsPath, { A: Wallet.generate().seed, B: Wallet.generate().seed, C: Wallet.generate().seed });
    }
    const secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));
    const wallets = { A: Wallet.fromSeed(secrets.A), B: Wallet.fromSeed(secrets.B), C: Wallet.fromSeed(secrets.C) };
    const tx = new Transactions(client, store);
    async function step(id, work) {
        if (store.state.steps[id])
            return;
        await work();
        store.state.steps[id] = true;
        store.save();
    }
    for (const [label, wallet] of Object.entries(wallets))
        await step(`fund/${label}`, () => tx.send(`fund/${label}`, {
            TransactionType: 'Payment', Account: ISSUER_ADDRESS, Destination: wallet.classicAddress, Amount: '10000000',
        }, issuerWallet));
    await step('configure-issuer-deposit-auth', () => MptIssuer.configureIssuer(tx, issuerWallet, 'configure-issuer-deposit-auth'));
    const issuer = store.state.issuanceId ? await MptIssuer.attach(tx, issuerWallet, store.state.issuanceId) : await MptIssuer.create(tx, issuerWallet, 'create');
    const result = { issuanceId: issuer.id, holders: { A: wallets.A.classicAddress, B: wallets.B.classicAddress, C: wallets.C.classicAddress } };
    // Recovery data is distinct from result.json, which is written only after final assertions pass.
    atomicJson('.state/demo-result.json', result);
    const { A, B, C } = result.holders;
    const payment = (from, to, value) => ({ TransactionType: 'Payment', Account: from.classicAddress,
        Destination: to, Amount: { mpt_issuance_id: issuer.id, value } });
    async function blocked(id, from, to, expected) {
        await step(id, async () => {
            try {
                await tx.send(id, payment(from, to, '1'), from);
            }
            catch (error) {
                if (error instanceof TransactionRejected && expected.includes(error.receipt.code))
                    return;
                throw error;
            }
            throw new Error(`Compliance failure: ${id} unexpectedly succeeded`);
        });
    }
    for (const [label, wallet] of Object.entries(wallets))
        await step(`opt-in/${label}`, () => tx.send(`opt-in/${label}`, issuer.optInTransaction(wallet.classicAddress), wallet));
    await blocked('deny-unapproved-issuer-to-C', issuerWallet, C, ['tecNO_AUTH']);
    for (const [label, address] of Object.entries(result.holders))
        await step(`approve/${label}`, () => issuer.approve(address, `approve/${label}`));
    await step('issue/A', () => issuer.issue(A, '501', 'issue/A'));
    await step('issue/B', () => issuer.issue(B, '1000', 'issue/B'));
    await step('issue/C', () => issuer.issue(C, '250', 'issue/C'));
    await step('clawback/B/300', async () => {
        await issuer.clawback(B, '300', 'clawback/B/300');
        assert.equal((await readHolding(client, issuer.id, B))?.MPTAmount, '700');
    });
    await step('freeze/A', () => issuer.freezeHolder(A, true, 'freeze/A'));
    await blocked('deny-frozen-A-to-B', wallets.A, B, ['tecLOCKED']);
    await blocked('deny-B-to-frozen-A', wallets.B, A, ['tecLOCKED']);
    // Historical operation ID retained for recovery: the live ledger demonstrated an issuer exception.
    await step('native-issuer-to-frozen-A-exception', () => tx.send('deny-issuer-to-frozen-A', payment(issuerWallet, A, '1'), issuerWallet));
    await step('deny-module-issuer-to-frozen-A', () => assert.rejects(issuer.issue(A, '1', 'forbidden-mint-frozen-A'), /unlocked/));
    await step('normalize-A-after-native-exception', () => issuer.clawback(A, '2', 'normalize-A-after-native-exception'));
    await blocked('deny-frozen-A-redemption', wallets.A, ISSUER_ADDRESS, ['tecNO_PERMISSION']);
    await step('unfreeze/A', () => issuer.freezeHolder(A, false, 'unfreeze/A'));
    await step('unfrozen-A-to-C', () => tx.send('unfrozen-A-to-C', payment(wallets.A, C, '1'), wallets.A));
    await step('C-to-unfrozen-A', () => tx.send('C-to-unfrozen-A', payment(wallets.C, A, '1'), wallets.C));
    await step('freeze/B', () => issuer.freezeHolder(B, true, 'freeze/B'));
    await step('global-freeze', () => issuer.freezeGlobal(true, 'global-freeze'));
    await blocked('deny-global-A-to-C', wallets.A, C, ['tecLOCKED']);
    await blocked('deny-global-C-to-A', wallets.C, A, ['tecLOCKED']);
    await step('deny-module-mint-global', () => assert.rejects(issuer.issue(A, '1', 'forbidden-mint-global'), /unlocked/));
    await blocked('deny-global-A-redemption', wallets.A, ISSUER_ADDRESS, ['tecNO_PERMISSION']);
    await step('global-unfreeze', async () => {
        await issuer.freezeGlobal(false, 'global-unfreeze');
        assert.equal((await readIssuance(client, issuer.id)).Flags & LOCKED, 0);
        assert.equal((await readHolding(client, issuer.id, B)).Flags & LOCKED, LOCKED);
    });
    await step('global-unfrozen-A-to-C', () => tx.send('global-unfrozen-A-to-C', payment(wallets.A, C, '1'), wallets.A));
    await step('global-unfrozen-C-to-A', () => tx.send('global-unfrozen-C-to-A', payment(wallets.C, A, '1'), wallets.C));
    await blocked('deny-B-still-frozen', wallets.B, A, ['tecLOCKED']);
    await blocked('deny-B-redemption', wallets.B, ISSUER_ADDRESS, ['tecNO_PERMISSION']);
    await step('ban/C', () => issuer.ban(C, 'Demo: compliance approval withdrawn', 'ban/C'));
    await blocked('deny-banned-issuer-to-C', issuerWallet, C, ['tecNO_AUTH']);
    await blocked('deny-banned-A-to-C', wallets.A, C, ['tecNO_AUTH']);
    await step('deny-local-reapproval-C', () => assert.rejects(issuer.approve(C, 'forbidden-reapproval-C'), /banned/));
    // Adversarial holder removes/recreates the entry: issuer authorization must not return.
    await step('C-delete-entry', () => tx.send('C-delete-entry', { ...issuer.optInTransaction(C), Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize }, wallets.C));
    await step('C-recreate-entry', () => tx.send('C-recreate-entry', issuer.optInTransaction(C), wallets.C));
    await blocked('deny-recreated-C', wallets.A, C, ['tecNO_AUTH']);
    const evidence = await verifyFinal(client, result);
    atomicJson('verification.json', evidence);
    atomicJson('demo-transactions.json', Object.fromEntries(Object.entries(store.state.transactions).map(([id, record]) => [id, record.receipt])));
    atomicJson('demo-report.json', {
        completedAt: new Date().toISOString(), checks: store.state.steps,
        validatedLedger: evidence.ledgerIndex,
        nativeLockException: {
            operationId: 'deny-issuer-to-frozen-A',
            expectedResult: 'tesSUCCESS',
            explanation: 'Historical probe ID. Testnet allows issuer payments to locked holders; application mint guards enforce the restriction.',
        },
        issuerPolicy: 'DepositAuth enabled, no DepositPreauth entries. Direct redemptions are blocked account-wide, including when unlocked.',
    });
    atomicJson('result.json', result);
    console.log(`Demo verified at ledger ${evidence.ledgerIndex}. result.json written.`);
}
finally {
    try {
        if (client.isConnected())
            await client.disconnect();
    }
    finally {
        store.close();
    }
}
