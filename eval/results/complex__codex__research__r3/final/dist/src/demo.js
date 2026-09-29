import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { Client, Wallet, MPTokenAuthorizeFlags } from 'xrpl';
import { MptIssuer, Ledger, Store, TESTNET, checkTestnet, TransactionFailure, optIn, payment } from './issuer.js';
import { ISSUER, verify } from './verify.js';
process.umask(0o077);
const seed = process.env.XRPL_ISSUER_SEED;
if (!seed)
    throw new Error('Set XRPL_ISSUER_SEED to the testnet issuer seed');
const issuerWallet = Wallet.fromSeed(seed);
assert.equal(issuerWallet.classicAddress, ISSUER, 'Unexpected issuer');
const client = new Client(TESTNET, { timeout: 30_000, maxFeeXRP: '0.001' });
mkdirSync('.private', { recursive: true, mode: 0o700 });
const store = new Store('.private/demo.sqlite');
const ledger = new Ledger(client, store);
const walletFile = '.private/holders.json';
let holderSeeds;
if (existsSync(walletFile))
    holderSeeds = JSON.parse(readFileSync(walletFile, 'utf8'));
else {
    holderSeeds = { A: Wallet.generate().seed, B: Wallet.generate().seed, C: Wallet.generate().seed };
    writeFileSync(walletFile, JSON.stringify(holderSeeds), { mode: 0o600, flag: 'wx' });
}
const A = Wallet.fromSeed(holderSeeds.A), B = Wallet.fromSeed(holderSeeds.B), C = Wallet.fromSeed(holderSeeds.C);
async function phase(name, action) {
    if (store.hasCheckpoint(name))
        return;
    await action();
    store.checkpoint(name);
}
async function send(key, wallet, tx) {
    return ledger.exclusive(() => ledger.submit(key, wallet, tx));
}
async function blocked(key, wallet, tx, codes) {
    try {
        await send(key, wallet, tx);
    }
    catch (error) {
        if (!(error instanceof TransactionFailure))
            throw error;
        assert(codes.includes(error.receipt.code), `Unexpected denial: ${error.receipt.code}`);
        return;
    }
    throw new Error(`Compliance violation: ${key} unexpectedly succeeded`);
}
try {
    await client.connect();
    const amendments = await checkTestnet(client);
    writeFileSync('research/demo-amendments.json', JSON.stringify(amendments, null, 2) + '\n');
    for (const [name, wallet] of Object.entries({ A, B, C })) {
        await send(`fund:${name}`, issuerWallet, { TransactionType: 'Payment', Account: ISSUER, Destination: wallet.address, Amount: '10000000' });
    }
    const issuer = await MptIssuer.create(ledger, issuerWallet, 'create:regulated-token');
    const id = issuer.id;
    const result = { issuanceId: id, holders: { A: A.address, B: B.address, C: C.address } };
    // Not result.json: the requested output is written only after final verification.
    writeFileSync('.private/deployment.json', JSON.stringify(result, null, 2) + '\n');
    await phase('setup', async () => {
        for (const [name, wallet] of Object.entries({ A, B, C }))
            await send(`opt-in:${name}`, wallet, optIn(wallet.address, id));
        await blocked('deny:unapproved', issuerWallet, payment(ISSUER, C.address, id, '1'), ['tecNO_AUTH']);
        for (const [name, wallet] of Object.entries({ A, B, C })) {
            // Demo fixtures only. A real backend calls approve only after its KYC decision.
            await issuer.approve(wallet.address, `demo-kyc-${name}`, `approve:${name}`);
        }
        await issuer.issue(A.address, '500', 'issue:A:500');
        await issuer.issue(B.address, '1000', 'issue:B:1000');
        await issuer.issue(C.address, '100', 'issue:C:100');
        await issuer.clawback(B.address, '300', 'clawback:B:300');
        await send('transfer:A:B', A, payment(A.address, B.address, id, '1'));
        await send('transfer:B:A', B, payment(B.address, A.address, id, '1'));
    });
    await phase('individual-freeze', async () => {
        await issuer.setHolderFreeze(A.address, true, 'freeze:A');
        await blocked('deny:A:outgoing', A, payment(A.address, B.address, id, '1'), ['tecLOCKED']);
        await blocked('deny:A:incoming', B, payment(B.address, A.address, id, '1'), ['tecLOCKED']);
        await phase('policy-check:A', () => assert.rejects(issuer.issue(A.address, '1', 'policy:deny:A'), /freeze policy/));
        // Original probe key retained in the journal: this unexpectedly succeeds on testnet.
        await send('deny:A:issuance', issuerWallet, payment(ISSUER, A.address, id, '1'));
        await send('exception:A:redeem-while-frozen', A, payment(A.address, ISSUER, id, '1'));
        await issuer.setHolderFreeze(A.address, false, 'unfreeze:A');
        // The one-unit raw issuance and redemption cancel; prove peer transfers work again.
        await send('transfer:A:B:after-thaw', A, payment(A.address, B.address, id, '1'));
        await send('transfer:B:A:after-thaw', B, payment(B.address, A.address, id, '1'));
    });
    await phase('global-freeze', async () => {
        await issuer.setGlobalFreeze(true, 'freeze:global');
        await blocked('deny:global:transfer', A, payment(A.address, B.address, id, '1'), ['tecLOCKED']);
        await phase('policy-check:global', () => assert.rejects(issuer.issue(A.address, '1', 'policy:deny:global'), /freeze policy/));
        await send('exception:global:issuance', issuerWallet, payment(ISSUER, A.address, id, '1'));
        await send('exception:A:redeem-while-global-frozen', A, payment(A.address, ISSUER, id, '1'));
        await issuer.setGlobalFreeze(false, 'unfreeze:global');
    });
    await phase('freeze-B', async () => {
        await issuer.setHolderFreeze(B.address, true, 'freeze:B');
        await blocked('deny:B:outgoing', B, payment(B.address, A.address, id, '1'), ['tecLOCKED']);
        await blocked('deny:B:incoming', A, payment(A.address, B.address, id, '1'), ['tecLOCKED']);
    });
    await phase('ban-C', async () => {
        await issuer.ban(C.address, 'Demo compliance ban');
        await blocked('deny:C:banned:issuer', issuerWallet, payment(ISSUER, C.address, id, '1'), ['tecNO_AUTH', 'tecLOCKED']);
        await blocked('deny:C:banned:peer', A, payment(A.address, C.address, id, '1'), ['tecNO_AUTH', 'tecLOCKED']);
        await assert.rejects(issuer.approve(C.address, 'demo-reapproval', 'forbidden:reapprove:C'), /banned/);
        await assert.rejects(issuer.setHolderFreeze(C.address, false, 'forbidden:unfreeze:C'), /banned/);
        // Adversarial holder deletes/recreates its zero-balance entry. Authorization must stay absent.
        await send('C:delete-holding', C, { ...optIn(C.address, id), Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize });
        await send('C:recreate-holding', C, optIn(C.address, id));
        await blocked('deny:C:recreated:issuer', issuerWallet, payment(ISSUER, C.address, id, '1'), ['tecNO_AUTH']);
        await blocked('deny:C:recreated:peer', A, payment(A.address, C.address, id, '1'), ['tecNO_AUTH']);
    });
    const snapshot = await verify(client, result);
    writeFileSync('verification.json', JSON.stringify(snapshot, null, 2) + '\n');
    writeFileSync('demo-evidence.json', JSON.stringify({ network: TESTNET, negativeTests: store.receipts().filter(r => r.code !== 'tesSUCCESS'), policyChecks: { individualIssuanceBlocked: store.hasCheckpoint('policy-check:A'), globalIssuanceBlocked: store.hasCheckpoint('policy-check:global') }, receipts: store.receipts() }, null, 2) + '\n');
    writeFileSync('result.json.tmp', JSON.stringify(result, null, 2) + '\n');
    renameSync('result.json.tmp', 'result.json');
    console.log(`Demo completed and verified at ledger ${snapshot.ledger}`);
}
finally {
    try {
        await client.disconnect();
    }
    finally {
        store.close();
    }
}
//# sourceMappingURL=demo.js.map