import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from 'xrpl';
import { CAPABILITIES } from './issuer.js';
import { preflight, TESTNET } from './ledger.js';

const result = JSON.parse(readFileSync('result.json', 'utf8')) as { issuanceId: string; holders: Record<'A' | 'B' | 'C', string> };
const client = new Client(TESTNET);
try {
  await client.connect(); await preflight(client);
  const ledgerIndex = await client.getLedgerIndex();
  const issuance = (await client.request({ command: 'ledger_entry', mpt_issuance: result.issuanceId, ledger_index: ledgerIndex })).result;
  assert.ok(issuance.validated);
  assert.equal(issuance.node.LedgerEntryType, 'MPTokenIssuance');
  const node = issuance.node as unknown as { Issuer: string; Flags: number; OutstandingAmount: string };
  assert.equal(node.Issuer, 'rp8Jk8kiQzfZeUuUTmWd1bvV4gSpbaQBAW');
  assert.equal(node.Flags, CAPABILITIES); assert.equal(node.OutstandingAmount, '1200');
  for (const name of ['A', 'B', 'C'] as const) {
    const r = (await client.request({ command: 'ledger_entry', mptoken: { account: result.holders[name], mpt_issuance_id: result.issuanceId }, ledger_index: ledgerIndex })).result;
    assert.ok(r.validated);
    const token = r.node as unknown as { LedgerEntryType: string; MPTAmount: string; Flags: number };
    assert.equal(token.LedgerEntryType, 'MPToken');
    token.MPTAmount ??= '0';
    assert.equal(token.MPTAmount, { A: '500', B: '700', C: '0' }[name]);
    assert.equal(token.Flags, { A: 2, B: 3, C: 0 }[name]);
    console.log(`${name}: ${token.MPTAmount}, authorized=${Boolean(token.Flags & 2)}, frozen=${Boolean(token.Flags & 1)}`);
  }
  console.log(`All final ledger assertions passed at validated ledger ${ledgerIndex}.`);
} finally { await client.disconnect(); }
