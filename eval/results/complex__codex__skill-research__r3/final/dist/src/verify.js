import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client } from 'xrpl';
import { MptIssuer, CAPABILITIES } from './issuer.js';
import { Journal, Runner, TESTNET } from './runtime.js';
export async function verify(runner, issuer, holders) {
    await issuer.assertConfiguration();
    const ledger = await runner.client.getLedgerIndex();
    const issuance = await issuer.issuance(ledger);
    const [A, B, C] = await Promise.all([issuer.holder(holders.A, ledger), issuer.holder(holders.B, ledger), issuer.holder(holders.C, ledger)]);
    assert.equal(issuance.Flags, CAPABILITIES);
    assert.equal(issuance.OutstandingAmount, '1200');
    assert.equal(A?.MPTAmount, '500');
    assert.equal(A.Flags, 2);
    assert.equal(B?.MPTAmount, '700');
    assert.equal(B.Flags, 3);
    assert.equal(C?.MPTAmount ?? '0', '0');
    assert.equal((C?.Flags ?? 0) & 2, 0);
    assert.ok(runner.journal.banned(issuer.issuanceId, holders.C));
    return { verifiedAt: new Date().toISOString(), ledger, issuance, holders: { A, B, C }, issuerDepositAuth: true, bannedC: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const result = JSON.parse(readFileSync('result.json', 'utf8'));
    const client = new Client(TESTNET);
    const journal = new Journal('.private/demo.sqlite');
    try {
        await client.connect();
        const runner = new Runner(client, journal);
        await runner.preflight();
        const issuer = new MptIssuer(runner, { address: 'rhXcp3PUXhNiJ2bA5uchbKjn71BrKv9Vck', sign: () => { throw new Error('Read-only'); } }, result.issuanceId);
        console.log(JSON.stringify(await verify(runner, issuer, result.holders), null, 2));
    }
    finally {
        await client.disconnect();
        journal.close();
    }
}
