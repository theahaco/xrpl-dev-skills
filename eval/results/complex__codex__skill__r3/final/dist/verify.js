import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from 'xrpl';
import { REQUIRED_FLAGS } from './issuer.js';
import { TESTNET } from './transactions.js';
export const ISSUER = 'rB3criap1CczhesHSP5oAT9XtrVZPUb9kV';
export async function verify(client, result) {
    const ledger = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result;
    const hash = ledger.ledger_hash;
    assert(hash);
    const issuance = (await client.request({ command: 'ledger_entry', mpt_issuance: result.issuanceId, ledger_hash: hash })).result;
    assert.equal(issuance.validated, true);
    assert.equal(issuance.node?.LedgerEntryType, 'MPTokenIssuance');
    if (issuance.node?.LedgerEntryType !== 'MPTokenIssuance')
        throw new Error('Invalid issuance');
    assert.equal(issuance.node.Issuer, ISSUER);
    assert.equal(issuance.node.Flags, REQUIRED_FLAGS);
    assert.equal(issuance.node.AssetScale ?? 0, 0);
    assert.equal(issuance.node.OutstandingAmount, '1200');
    const holders = {};
    for (const name of ['A', 'B', 'C']) {
        const holding = (await client.request({ command: 'ledger_entry',
            mptoken: { mpt_issuance_id: result.issuanceId, account: result.holders[name] }, ledger_hash: hash })).result;
        assert.equal(holding.validated, true);
        assert(holding.node);
        assert.equal(holding.node.LedgerEntryType, 'MPToken');
        assert.equal(holding.node.MPTAmount ?? '0', { A: '500', B: '700', C: '0' }[name]);
        assert.equal(holding.node.Flags & 2, name === 'C' ? 0 : 2);
        assert.equal(holding.node.Flags & 1, name === 'B' ? 1 : 0);
        holders[name] = holding.node;
    }
    return { network: 'testnet', ledgerHash: hash, ledgerIndex: ledger.ledger_index, issuer: ISSUER, issuance: issuance.node, holders };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const client = new Client(TESTNET);
    try {
        await client.connect();
        const result = JSON.parse(await readFile('result.json', 'utf8'));
        const snapshot = await verify(client, result);
        await writeFile('verification.json', JSON.stringify(snapshot, null, 2) + '\n');
        console.log(`Verified final state at testnet ledger ${snapshot.ledgerIndex}`);
    }
    finally {
        await client.disconnect();
    }
}
