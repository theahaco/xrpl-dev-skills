import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client } from 'xrpl';
import { CAPABILITIES, snapshot } from './issuer.js';
import { TESTNET } from './ledger.js';
import { atomicJson } from './store.js';
export const ISSUER = 'rGDjhvNHdxyhRQRSsukGXnkNiZvyReN4vv';
export function assertFinal(state, result) {
    assert.equal(state.issuance.Issuer, ISSUER);
    assert.equal(state.issuance.Flags, CAPABILITIES);
    assert.equal(state.issuance.AssetScale ?? 0, 0);
    assert.equal(state.issuance.OutstandingAmount, '1200');
    const a = state.holders[result.holders.A];
    const b = state.holders[result.holders.B];
    const c = state.holders[result.holders.C];
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.MPTAmount, '500');
    assert.equal(a.Flags, 2);
    assert.equal(b.MPTAmount, '700');
    assert.equal(b.Flags, 3);
    assert.equal(c?.MPTAmount ?? '0', '0');
    assert.equal((c?.Flags ?? 0) & 2, 0);
}
async function main() {
    const result = JSON.parse(readFileSync('result.json', 'utf8'));
    const client = new Client(TESTNET);
    try {
        await client.connect();
        const state = await snapshot(client, result.issuanceId, Object.values(result.holders));
        assertFinal(state, result);
        atomicJson('verification.json', state);
        console.log(`Verified final state at ledger ${state.ledgerIndex} (${state.ledgerHash})`);
    }
    finally {
        await client.disconnect();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error instanceof Error ? error.message : 'Verification failed'); process.exitCode = 1; });
}
