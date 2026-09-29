import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client } from 'xrpl';
import { CAPABILITIES } from './issuer.js';
import { TESTNET } from './ledger.js';
export const ISSUER = 'rnS9o1Trk4KyspmMjGeWFBdpwhhGprFFh1';
export async function verify(client, result) {
    const info = (await client.request({ command: 'server_info' })).result.info;
    assert.equal(info.network_id, 1);
    const ledger = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result;
    const ledger_hash = ledger.ledger_hash;
    const issuance = (await client.request({ command: 'ledger_entry', mpt_issuance: result.issuanceId, ledger_hash })).result;
    assert.equal(issuance.validated, true);
    assert.equal(issuance.node?.LedgerEntryType, 'MPTokenIssuance');
    if (issuance.node?.LedgerEntryType !== 'MPTokenIssuance')
        throw new Error('Missing issuance');
    assert.equal(issuance.node.Issuer, ISSUER);
    assert.equal(issuance.node.Flags, CAPABILITIES);
    assert.equal(issuance.node.AssetScale ?? 0, 0);
    assert.equal(issuance.node.OutstandingAmount, '1200');
    const holders = {};
    for (const label of ['A', 'B', 'C']) {
        const response = (await client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: result.issuanceId, account: result.holders[label] }, ledger_hash })).result;
        assert.equal(response.validated, true);
        const node = response.node;
        assert.equal(node.LedgerEntryType, 'MPToken');
        assert.equal(node.Account, result.holders[label]);
        assert.equal(node.MPTAmount ?? '0', label === 'A' ? '500' : label === 'B' ? '700' : '0');
        assert.equal(Boolean(node.Flags & 2), label !== 'C');
        assert.equal(Boolean(node.Flags & 1), label === 'B'); // C re-opted in during bypass test.
        holders[label] = node;
    }
    const account = (await client.request({ command: 'account_info', account: ISSUER, ledger_hash })).result.account_data;
    assert.ok(account.Flags & 0x01000000);
    let marker;
    do {
        const r = await client.request({ command: 'account_objects', account: ISSUER, ledger_hash, type: 'deposit_preauth', ...(marker ? { marker } : {}) });
        assert.equal(r.result.account_objects.length, 0);
        marker = r.result.marker;
    } while (marker);
    return { verifiedAt: new Date().toISOString(), ledgerHash: ledger_hash, ledgerIndex: ledger.ledger_index, issuance: issuance.node, holders, issuer: account };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const client = new Client(TESTNET);
    try {
        await client.connect();
        const evidence = await verify(client, JSON.parse(readFileSync('result.json', 'utf8')));
        writeFileSync('evidence/verification.json', JSON.stringify(evidence, null, 2) + '\n');
        console.log(`Verified final state at ledger ${evidence.ledgerIndex}`);
    }
    finally {
        await client.disconnect();
    }
}
