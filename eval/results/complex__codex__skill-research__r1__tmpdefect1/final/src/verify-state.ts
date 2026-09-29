import assert from 'node:assert/strict';
import { type Client, type LedgerEntryRequest, type LedgerEntryJsonResponse } from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import { CAPABILITIES } from './issuer.js';
export interface DemoResult { issuanceId: string; holders: Record<'A' | 'B' | 'C', string> }
export async function verify(client: Client, result: DemoResult) {
  const ledger = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result;
  const issuance = (await client.request({ command: 'ledger_entry', ledger_hash: ledger.ledger_hash, mpt_issuance: result.issuanceId })).result.node;
  if (issuance.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Invalid issuance');
  assert.equal(issuance.Issuer, 'rsrPoacdWBwtfcTAxQ6C66d82bmaaTZuR3');
  assert.equal(issuance.Flags, CAPABILITIES); assert.equal(issuance.OutstandingAmount, '1200');
  assert.equal(issuance.AssetScale ?? 0, 0);
  const holders: Record<string, MPToken> = {};
  for (const [name, address] of Object.entries(result.holders)) {
    holders[name] = (await client.request<LedgerEntryRequest, 2, LedgerEntryJsonResponse<MPToken>>({
      command: 'ledger_entry', ledger_hash: ledger.ledger_hash,
      mptoken: { mpt_issuance_id: result.issuanceId, account: address },
    })).result.node;
  }
  assert.equal(holders.A?.MPTAmount, '500'); assert.equal(holders.A!.Flags, 2);
  assert.equal(holders.B?.MPTAmount, '700'); assert.equal(holders.B!.Flags, 3);
  assert.ok(holders.C); assert.equal(holders.C.MPTAmount ?? '0', '0'); assert.equal(holders.C.Flags & 2, 0);
  return { ledgerIndex: ledger.ledger_index, ledgerHash: ledger.ledger_hash, issuance, holders };
}
