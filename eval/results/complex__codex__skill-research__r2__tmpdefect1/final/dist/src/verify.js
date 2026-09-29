import { Client } from 'xrpl';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ISSUANCE_FLAGS, readHolder, readIssuance } from './issuer.js';
import { TESTNET, checkTestnet } from './transactions.js';
export const ISSUER = 'rHC7MJurChypCr88ZRKXKMf89qxrSiqicX';
export async function verify(client, result) {
    await checkTestnet(client);
    const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
    const index = ledger.result.ledger_index;
    const [issuance, A, B, C] = await Promise.all([
        readIssuance(client, result.issuanceId, index),
        ...['A', 'B', 'C'].map(name => readHolder(client, result.issuanceId, result.holders[name], index)),
    ]);
    assert.equal(issuance.Issuer, ISSUER);
    assert.equal(issuance.Flags, ISSUANCE_FLAGS);
    assert.equal(issuance.OutstandingAmount, '1200');
    assert.equal(issuance.AssetScale ?? 0, 0);
    assert.equal(A?.MPTAmount, '500');
    assert.equal(A?.Flags, 2);
    assert.equal(B?.MPTAmount, '700');
    assert.equal(B?.Flags, 3);
    assert.equal(C?.MPTAmount ?? '0', '0');
    assert.equal((C?.Flags ?? 0) & 2, 0);
    return { checkedAt: new Date().toISOString(), ledgerIndex: index, ledgerHash: ledger.result.ledger_hash,
        issuer: ISSUER, issuance, holders: { A, B, C }, freezeLimitation: 'Native MPT locks permit redemption to issuer, payments from issuer, and clawback; not an absolute no-movement freeze.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const client = new Client(TESTNET);
    try {
        await client.connect();
        const result = JSON.parse(await readFile('result.json', 'utf8'));
        const evidence = await verify(client, result);
        await writeFile('verification.json', JSON.stringify(evidence, null, 2) + '\n');
        console.log(`Verified final state at ledger ${evidence.ledgerIndex}`);
    }
    finally {
        await client.disconnect();
    }
}
//# sourceMappingURL=verify.js.map