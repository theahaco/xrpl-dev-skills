import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from 'xrpl';
import { CAPABILITIES, MptIssuer, TESTNET, TransactionExecutor } from './issuer.js';
import { FileStore } from './store.js';
export const ISSUER_ADDRESS = 'rHHvDzJXJZWgUoU2qijyBxQnXeBXd8EhD5';
export async function verify(client, result) {
    const readOnly = { address: ISSUER_ADDRESS, sign: async () => { throw new Error('Read only'); } };
    const executor = new TransactionExecutor(client, await FileStore.load('.private/journal.json'));
    await executor.assertTestnet();
    const issuer = new MptIssuer(executor, readOnly, result.issuanceId);
    const ledger = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result;
    const index = ledger.ledger_index;
    const [issuance, A, B, C] = await Promise.all([
        issuer.issuance(index), issuer.holder(result.holders.A, index),
        issuer.holder(result.holders.B, index), issuer.holder(result.holders.C, index),
    ]);
    assert.equal(issuance.Issuer, ISSUER_ADDRESS);
    assert.equal(issuance.Flags, CAPABILITIES);
    assert.equal(issuance.OutstandingAmount, '1200');
    assert.equal(issuance.AssetScale ?? 0, 0);
    assert.equal(A?.MPTAmount, '500');
    assert.equal(A.Flags & 3, 2);
    assert.equal(B?.MPTAmount, '700');
    assert.equal(B.Flags & 3, 3);
    assert.equal(C?.MPTAmount ?? '0', '0');
    assert.equal((C?.Flags ?? 0) & 2, 0);
    const evidence = { network: 'testnet', issuer: ISSUER_ADDRESS, ledgerIndex: index,
        ledgerHash: ledger.ledger_hash, verifiedAt: new Date().toISOString(), issuance, holders: { A, B, C } };
    await writeFile('verification.json', JSON.stringify(evidence, null, 2) + '\n');
    console.log(`Verified final state at ledger ${index}: A=500 unlocked, B=700 locked, C=0 unauthorized, global unlocked`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const client = new Client(TESTNET);
    try {
        await client.connect();
        await verify(client, JSON.parse(await readFile('result.json', 'utf8')));
    }
    finally {
        await client.disconnect();
    }
}
