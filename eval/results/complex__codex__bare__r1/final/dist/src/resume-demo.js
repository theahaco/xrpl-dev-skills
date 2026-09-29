import { Client, Wallet } from 'xrpl';
import { open, readFile, writeFile, rename } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { MptIssuer, TransactionRunner, LedgerFailure, CAPABILITIES } from './issuer.js';
const client = new Client('wss://s.altnet.rippletest.net:51233');
const issuer = Wallet.fromSeed(process.env.ISSUER_SEED ?? '');
assert.equal(issuer.classicAddress, 'rUTfAPXoR2Pi5iUEtKYDeozNnQ4UmZQuzC');
async function durableAppend(path, data) {
    const file = await open(path, 'a', 0o600);
    try {
        await file.writeFile(JSON.stringify(data) + '\n');
        await file.sync();
    }
    finally {
        await file.close();
    }
}
const runner = new TransactionRunner(client, event => durableAppend('audit.jsonl', event));
const bans = new Set();
try {
    for (const line of (await readFile('bans.jsonl', 'utf8')).trim().split('\n').filter(Boolean))
        bans.add(JSON.parse(line));
}
catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw error;
}
const policy = {
    async isBanned(id, holder) { return bans.has(`${id}:${holder}`); },
    async ban(id, holder) { const key = `${id}:${holder}`; await durableAppend('bans.jsonl', key); bans.add(key); }
};
// Recovery of this demo after validated clawback; no minting or funding is repeated.
const saved = JSON.parse(await readFile('.demo-secrets.json', 'utf8'));
const progress = JSON.parse(await readFile('demo-progress.json', 'utf8'));
const A = Wallet.fromSeed(saved.A), B = Wallet.fromSeed(saved.B), C = Wallet.fromSeed(saved.C);
try {
    await client.connect();
    const token = await MptIssuer.attach(runner, issuer, progress.issuanceId, policy);
    const pay = (from, to, value = '1') => ({ TransactionType: 'Payment', Account: from.classicAddress, Destination: to.classicAddress, Amount: { mpt_issuance_id: token.issuanceId, value } });
    async function blocked(label, from, to, codes) {
        try {
            await runner.submit(from, pay(from, to));
            assert.fail(`${label} unexpectedly succeeded`);
        }
        catch (error) {
            if (!(error instanceof LedgerFailure) || !codes.includes(error.code))
                throw error;
            console.log(`${label}: ${error.code}`);
        }
    }
    await token.ban(C.classicAddress);
    await token.ban(C.classicAddress); // Idempotent resume.
    await blocked('Banned holder receives', A, C, ['tecNO_AUTH']);
    await blocked('Issuer cannot pay banned holder', issuer, C, ['tecNO_AUTH']);
    await assert.rejects(token.approve(C.classicAddress), /banned/);
    // Deleting and re-creating the holder object must not bypass issuer authorization.
    await runner.submit(C, { TransactionType: 'MPTokenAuthorize', Account: C.classicAddress, MPTokenIssuanceID: token.issuanceId, Flags: 1 });
    await runner.submit(C, { TransactionType: 'MPTokenAuthorize', Account: C.classicAddress, MPTokenIssuanceID: token.issuanceId });
    await blocked('Recreated banned holder receives', A, C, ['tecNO_AUTH']);
    const ledger = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
    const issuance = await token.issuance(ledger);
    const states = await Promise.all([A, B, C].map(h => token.holder(h.classicAddress, ledger)));
    assert.equal(issuance.Flags, CAPABILITIES);
    assert.equal(issuance.OutstandingAmount, '1200');
    for (const [i, balance, flags] of [[0, '500', 2], [1, '700', 3], [2, '0', 0]]) {
        assert.equal(states[i]?.MPTAmount, balance);
        assert.equal(states[i]?.Flags, flags);
    }
    await writeFile('verification.json', JSON.stringify({ ledger, issuance, holders: states }, null, 2));
    await rename('demo-progress.json', 'result.json');
    console.log('Verified final ledger state. Written result.json');
}
finally {
    await client.disconnect();
}
