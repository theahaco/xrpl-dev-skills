import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Client } from 'xrpl';
import { TESTNET } from './ledger.js';
import { AUTHORIZED, LOCKED, REQUIRED_FLAGS } from './issuer.js';
import { readJson, writeJson } from './storage.js';
export interface DemoResult { issuanceId: string; holders: { A: string; B: string; C: string } }
export async function verify(client: Client, result: DemoResult): Promise<void> {
  const ledger = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result;
  assert.equal(ledger.validated, true);
  const read = async (query: { mpt_issuance: string } | { mptoken: { mpt_issuance_id: string; account: string } }) => {
    const response = await client.request({ command: 'ledger_entry', ledger_hash: ledger.ledger_hash, ...query });
    assert.equal(response.result.validated, true);
    return response.result.node as unknown as Record<string, unknown>;
  };
  const issuance = await read({ mpt_issuance: result.issuanceId });
  assert.equal(issuance.Issuer, 'rnALUjoU7amSCUJkk18CxbfFhsQ9JtcJ3u');
  assert.equal(issuance.Flags, REQUIRED_FLAGS);
  assert.equal(issuance.OutstandingAmount, '1200');
  const holdings: Record<string, unknown> = {};
  for (const [name, holder] of Object.entries(result.holders)) {
    const entry = await read({ mptoken: { mpt_issuance_id: result.issuanceId, account: holder } });
    assert.equal(entry.MPTAmount ?? '0', name === 'A' ? '500' : name === 'B' ? '700' : '0');
    const flags = entry.Flags as number;
    assert.equal(Boolean(flags & AUTHORIZED), name !== 'C');
    if (name !== 'C') assert.equal(Boolean(flags & LOCKED), name === 'B');
    holdings[name] = entry;
  }
  writeJson('verification.json', { network: TESTNET, ledgerHash: ledger.ledger_hash, ledgerIndex: ledger.ledger_index, checkedAt: new Date().toISOString(), issuance, holdings });
  console.log(`Final state verified at ledger ${ledger.ledger_index}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new Client(TESTNET);
  try { await client.connect(); await verify(client, readJson('result.json') as DemoResult); }
  finally { await client.disconnect(); }
}
