import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from 'xrpl';
import { ISSUANCE_FLAGS, address, issuanceId } from './issuer.js';
import { TESTNET, checkTestnet } from './ledger.js';
export const ISSUER = 'rsGdajs49wqpyofW5LVjWH9ZVJdmWJSEDm';
export async function verify(client, result) {
    issuanceId(result.issuanceId);
    for (const holder of Object.values(result.holders))
        address(holder);
    const ledger = await client.getLedgerIndex();
    const issuance = await client.request({ command: 'ledger_entry', mpt_issuance: result.issuanceId, ledger_index: ledger });
    const node = issuance.result.node;
    assert.equal(issuance.result.validated, true);
    assert.equal(node?.LedgerEntryType, 'MPTokenIssuance');
    if (node?.LedgerEntryType !== 'MPTokenIssuance')
        throw new Error('Missing issuance');
    assert.equal(node.Issuer, ISSUER);
    assert.equal(node.Flags, ISSUANCE_FLAGS);
    assert.equal(node.AssetScale ?? 0, 0);
    assert.equal(node.OutstandingAmount, '1200');
    const holders = {};
    for (const [name, holder] of Object.entries(result.holders)) {
        const response = await client.request({
            command: 'ledger_entry', mptoken: { account: holder, mpt_issuance_id: result.issuanceId }, ledger_index: ledger,
        });
        assert.equal(response.result.validated, true);
        assert(response.result.node);
        const holding = { ...response.result.node, MPTAmount: response.result.node.MPTAmount ?? '0' };
        assert.equal(holding.MPTAmount, name === 'A' ? '500' : name === 'B' ? '700' : '0');
        assert.equal(holding.Flags & 2, name === 'C' ? 0 : 2);
        assert.equal(holding.Flags & 1, name === 'B' ? 1 : 0);
        holders[name] = holding;
    }
    return { verifiedAt: new Date().toISOString(), ledger, issuance: node, holders };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const client = new Client(TESTNET);
    try {
        await client.connect();
        await checkTestnet(client);
        const result = JSON.parse(await readFile('result.json', 'utf8'));
        const snapshot = await verify(client, result);
        await writeFile('verification.json', JSON.stringify(snapshot, null, 2) + '\n');
        console.log(`Verified all final conditions at validated testnet ledger ${snapshot.ledger}`);
    }
    finally {
        await client.disconnect();
    }
}
//# sourceMappingURL=verify.js.map