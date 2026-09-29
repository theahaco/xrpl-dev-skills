import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from 'xrpl';
import { CAPABILITIES, TESTNET } from './issuer.js';

export interface Result { issuanceId: string; holders: { A: string; B: string; C: string } }
export const ISSUER = 'rfVyKGDbMdUjJCJ1z9Qd8JBGQnyR7WQeXb';
export async function verify(client: Client, result: Result): Promise<unknown> {
  const ledger = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result;
  const issuance = (await client.request({ command: 'ledger_entry', mpt_issuance: result.issuanceId, ledger_hash: ledger.ledger_hash })).result.node;
  assert.equal(issuance.LedgerEntryType, 'MPTokenIssuance');
  assert.equal('Issuer' in issuance && issuance.Issuer, ISSUER);
  assert.equal(issuance.Flags, CAPABILITIES);
  assert.equal('OutstandingAmount' in issuance && issuance.OutstandingAmount, '1200');
  const holders: Record<string, unknown> = {};
  for (const [name, address] of Object.entries(result.holders)) {
    const node = (await client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: result.issuanceId, account: address }, ledger_hash: ledger.ledger_hash })).result.node as unknown as { LedgerEntryType: string; Flags: number; MPTAmount?: string };
    assert.equal(node.LedgerEntryType, 'MPToken');
    assert.equal(node.MPTAmount ?? '0', name === 'A' ? '500' : name === 'B' ? '700' : '0');
    assert.equal(node.Flags, name === 'A' ? 2 : name === 'B' ? 3 : 1);
    holders[name] = node;
  }
  return { network: 'testnet', ledgerIndex: ledger.ledger_index, ledgerHash: ledger.ledger_hash, issuance, holders };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new Client(TESTNET);
  try {
    await client.connect();
    const result = JSON.parse(await readFile('result.json', 'utf8')) as Result;
    const report = await verify(client, result);
    await writeFile('verification.json', JSON.stringify(report, null, 2) + '\n');
    console.log('Validated final state matches all balance and flag assertions.');
  } finally { await client.disconnect(); }
}
