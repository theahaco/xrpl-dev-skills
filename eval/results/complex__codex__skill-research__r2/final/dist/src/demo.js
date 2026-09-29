import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Client, Wallet, xrpToDrops } from 'xrpl';
import { CAPABILITIES, Issuer, optIn } from './issuer.js';
import { Ledger, LedgerFailure, preflight, TESTNET } from './ledger.js';
import { Store } from './store.js';
const EXPECTED_ISSUER = 'rp8Jk8kiQzfZeUuUTmWd1bvV4gSpbaQBAW';
const seed = process.env.ISSUER_SEED;
if (!seed)
    throw new Error('Set ISSUER_SEED in the environment');
const issuerWallet = Wallet.fromSeed(seed);
assert.equal(issuerWallet.classicAddress, EXPECTED_ISSUER, 'Wrong issuer seed');
mkdirSync('.local', { recursive: true, mode: 0o700 });
const store = new Store('.local/demo.sqlite');
// Encrypted recovery of demo holder keys. Issuer seed is never persisted.
function holders() {
    const path = '.local/holders.enc.json';
    if (!existsSync(path)) {
        const salt = randomBytes(16), iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', scryptSync(seed, salt, 32), iv);
        const secrets = JSON.stringify(Object.fromEntries(['A', 'B', 'C'].map(k => [k, Wallet.generate().seed])));
        const encrypted = Buffer.concat([cipher.update(secrets), cipher.final()]);
        writeFileSync(path, JSON.stringify({ salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('hex') }), { mode: 0o600, flag: 'wx', flush: true });
    }
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(seed, Buffer.from(data.salt, 'hex'), 32), Buffer.from(data.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
    const seeds = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.data, 'hex')), decipher.final()]).toString());
    return { A: Wallet.fromSeed(seeds.A), B: Wallet.fromSeed(seeds.B), C: Wallet.fromSeed(seeds.C) };
}
const wallets = holders();
const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
const ledger = new Ledger(client, store);
async function step(id, fn) {
    if (store.get(`demo:${id}`))
        return;
    console.log(`Running ${id}`);
    await fn();
    store.put(`demo:${id}`, true);
}
function transfer(from, to, issuanceId, value = '1') {
    return { TransactionType: 'Payment', Account: from.classicAddress, Destination: to, Amount: { mpt_issuance_id: issuanceId, value } };
}
const evidence = store.get('evidence') ?? [];
async function blocked(id, tx, wallet, expected) {
    try {
        await ledger.exclusive(() => ledger.send(id, tx, wallet));
        throw new Error(`Compliance check FAILED: ${id} unexpectedly succeeded`);
    }
    catch (error) {
        if (!(error instanceof LedgerFailure) || !expected.includes(error.receipt.code))
            throw error;
        if (!evidence.some(e => e.test === id))
            evidence.push({ test: id, ...error.receipt });
        store.put('evidence', evidence);
        console.log(`Verified ${id}: ${error.receipt.code}`);
    }
}
try {
    await client.connect();
    await preflight(client);
    const info = (await client.request({ command: 'server_info' })).result.info;
    writeFileSync('research/demo-server-info.json', JSON.stringify(info, null, 2) + '\n');
    await step('fund', async () => {
        const reserve = info.validated_ledger;
        assert.ok(Number(reserve.reserve_base_xrp) + Number(reserve.reserve_inc_xrp) + 0.1 < 5, 'Funding must cover live reserves');
        const account = (await client.request({ command: 'account_info', account: EXPECTED_ISSUER, ledger_index: 'validated' })).result.account_data;
        assert.ok(BigInt(account.Balance) > BigInt(xrpToDrops(String(15 + Number(reserve.reserve_base_xrp) + Number(reserve.reserve_inc_xrp) * (account.OwnerCount + 1) + 1))), 'Insufficient issuer spendable XRP');
        for (const [name, wallet] of Object.entries(wallets))
            await ledger.exclusive(() => ledger.send(`fund:${name}`, { TransactionType: 'Payment', Account: EXPECTED_ISSUER, Destination: wallet.classicAddress, Amount: xrpToDrops('5') }, issuerWallet));
    });
    const token = await Issuer.create(ledger, issuerWallet, 'create');
    store.put('issuanceId', token.issuanceId);
    const id = token.issuanceId;
    await step('opt-in', async () => {
        for (const [name, wallet] of Object.entries(wallets))
            await ledger.exclusive(() => ledger.send(`opt-in:${name}`, optIn(wallet.classicAddress, id), wallet));
    });
    await step('allowlist', async () => {
        await blocked('unapproved-issuer-payment', transfer(issuerWallet, wallets.A.classicAddress, id), issuerWallet, ['tecNO_AUTH']);
        for (const [name, wallet] of Object.entries(wallets))
            await token.approve(wallet.classicAddress, `approve:${name}`);
        await token.issue(wallets.A.classicAddress, '500', 'issue:A');
        await token.issue(wallets.B.classicAddress, '1000', 'issue:B');
        await token.issue(wallets.C.classicAddress, '200', 'issue:C');
    });
    await step('freeze-A', async () => {
        await token.freeze(wallets.A.classicAddress, 'freeze:A');
        await blocked('frozen-A-outbound', transfer(wallets.A, wallets.B.classicAddress, id), wallets.A, ['tecLOCKED']);
        await blocked('frozen-A-inbound', transfer(wallets.B, wallets.A.classicAddress, id), wallets.B, ['tecLOCKED']);
        await assert.rejects(token.issue(wallets.A.classicAddress, '1', 'module-frozen-A-issuance'), /locked/);
        await ledger.exclusive(() => ledger.send('frozen-A-issuance', transfer(issuerWallet, wallets.A.classicAddress, id), issuerWallet));
        // Explicitly demonstrate the protocol exception rather than hide it from compliance.
        await ledger.exclusive(() => ledger.send('frozen-A-redemption-exception', transfer(wallets.A, EXPECTED_ISSUER, id), wallets.A));
        await token.unfreeze(wallets.A.classicAddress, 'unfreeze:A');
        await ledger.exclusive(() => ledger.send('A-to-B-after-unfreeze', transfer(wallets.A, wallets.B.classicAddress, id), wallets.A));
        await ledger.exclusive(() => ledger.send('B-to-A-after-unfreeze', transfer(wallets.B, wallets.A.classicAddress, id), wallets.B));
    });
    await step('clawback-and-freeze-B', async () => {
        await token.clawback(wallets.B.classicAddress, '300', 'clawback:B:300');
        await token.freeze(wallets.B.classicAddress, 'freeze:B');
        await blocked('frozen-B-outbound', transfer(wallets.B, wallets.A.classicAddress, id), wallets.B, ['tecLOCKED']);
        await blocked('frozen-B-inbound', transfer(wallets.A, wallets.B.classicAddress, id), wallets.A, ['tecLOCKED']);
    });
    await step('global-freeze', async () => {
        await token.freezeGlobal('global:freeze');
        await blocked('global-holder-payment', transfer(wallets.A, wallets.C.classicAddress, id), wallets.A, ['tecLOCKED']);
        await assert.rejects(token.issue(wallets.A.classicAddress, '1', 'module-global-issuance'), /locked/);
        await ledger.exclusive(() => ledger.send('global-issuance', transfer(issuerWallet, wallets.A.classicAddress, id), issuerWallet));
        await ledger.exclusive(() => ledger.send('global-redemption-exception', transfer(wallets.A, EXPECTED_ISSUER, id), wallets.A));
        await token.unfreezeGlobal('global:unfreeze');
    });
    await step('ban-C', async () => {
        await token.ban(wallets.C.classicAddress, 'ban:C');
        await blocked('banned-C-holder-payment', transfer(wallets.A, wallets.C.classicAddress, id), wallets.A, ['tecNO_AUTH']);
        await blocked('banned-C-issuer-payment', transfer(issuerWallet, wallets.C.classicAddress, id), issuerWallet, ['tecNO_AUTH']);
        await assert.rejects(token.approve(wallets.C.classicAddress, 'forbidden-reapproval'), /banned/);
        await assert.rejects(token.unfreeze(wallets.C.classicAddress, 'forbidden-unfreeze'), /banned/);
        await ledger.exclusive(() => ledger.send('C-remove-empty-holding', { ...optIn(wallets.C.classicAddress, id), Flags: 1 }, wallets.C));
        await ledger.exclusive(() => ledger.send('C-recreate-holding', optIn(wallets.C.classicAddress, id), wallets.C));
        await blocked('banned-C-recreated-holder-payment', transfer(wallets.A, wallets.C.classicAddress, id), wallets.A, ['tecNO_AUTH']);
    });
    const ledgerIndex = await client.getLedgerIndex();
    const issuance = await token.issuance(ledgerIndex);
    const A = await token.holding(wallets.A.classicAddress, ledgerIndex);
    const B = await token.holding(wallets.B.classicAddress, ledgerIndex);
    const C = await token.holding(wallets.C.classicAddress, ledgerIndex);
    assert.equal(issuance.Issuer, EXPECTED_ISSUER);
    assert.equal(issuance.Flags, CAPABILITIES);
    assert.equal(issuance.OutstandingAmount, '1200');
    assert.equal(A?.MPTAmount, '500');
    assert.equal(A.Flags, 2);
    assert.equal(B?.MPTAmount, '700');
    assert.equal(B.Flags, 3);
    assert.equal(C?.MPTAmount, '0');
    assert.equal(C.Flags & 2, 0);
    assert.ok(token.isBanned(wallets.C.classicAddress));
    writeFileSync('result.json', JSON.stringify({ issuanceId: id, holders: Object.fromEntries(Object.entries(wallets).map(([key, wallet]) => [key, wallet.classicAddress])) }, null, 2) + '\n', { flush: true });
    writeFileSync('transaction-audit.json', JSON.stringify(store.entries('tx:').map(({ key, value }) => ({ operationId: key.slice(3), receipt: value.receipt })), null, 2) + '\n', { flush: true });
    writeFileSync('demo-evidence.json', JSON.stringify({ network: TESTNET, issuer: EXPECTED_ISSUER, ledgerIndex, verifiedAt: new Date().toISOString(), issuance, holders: { A, B, C }, negativeTests: evidence, limitation: 'Local and global locks permit direct issuer payments in both directions. The module blocks issuance while locked; direct ledger redemption remains possible. All four exceptions were demonstrated.' }, null, 2) + '\n', { flush: true });
    console.log(`Verified final state at ledger ${ledgerIndex}. Written result.json and demo-evidence.json.`);
}
finally {
    await client.disconnect();
    store.close();
}
