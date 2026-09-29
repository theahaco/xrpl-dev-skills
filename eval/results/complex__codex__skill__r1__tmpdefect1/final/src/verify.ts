import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client } from 'xrpl';
import { CAPABILITIES, TESTNET } from './issuer.js';

export interface DemoResult { issuanceId: string; holders: Record<'A' | 'B' | 'C', string> }
export async function verify(client: Client, result: DemoResult) {
  const ledger = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result;
  const index = ledger.ledger_index;
  const issuance = (await client.request({ command: 'ledger_entry', mpt_issuance: result.issuanceId,
    ledger_index: index })).result.node;
  assert.equal(issuance.LedgerEntryType, 'MPTokenIssuance');
  if (issuance.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Invalid issuance');
  assert.equal(issuance.Issuer, 'rEhS5hFsARRniruZPfLauD2U1hrnt3RpnP');
  assert.equal(issuance.Flags, CAPABILITIES);
  assert.equal(issuance.AssetScale ?? 0, 0);
  assert.equal(issuance.OutstandingAmount, '1200');
  const states: Record<string, unknown> = {};
  for (const [label, expectedBalance, expectedFlags] of [['A', '500', 2], ['B', '700', 3], ['C', '0', 0]] as const) {
    const node = (await client.request({ command: 'ledger_entry', mptoken: {
      account: result.holders[label], mpt_issuance_id: result.issuanceId }, ledger_index: index })).result.node;
    const raw = node as unknown as { LedgerEntryType: string; MPTAmount: string; Flags: number };
    assert.equal(raw.LedgerEntryType, 'MPToken');
    assert.equal(raw.MPTAmount ?? '0', expectedBalance, `${label} balance`);
    assert.equal(raw.Flags, expectedFlags, `${label} authorization/freeze flags`);
    states[label] = node;
  }
  return { network: 'testnet', ledgerIndex: index, ledgerHash: ledger.ledger_hash,
    verifiedAt: new Date().toISOString(), issuance, holders: states };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new Client(TESTNET);
  try {
    await client.connect();
    const result = JSON.parse(readFileSync('result.json', 'utf8')) as DemoResult;
    console.log(JSON.stringify(await verify(client, result), null, 2));
  } finally { await client.disconnect(); }
}
