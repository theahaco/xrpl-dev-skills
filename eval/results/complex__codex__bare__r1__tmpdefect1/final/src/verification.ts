import assert from 'node:assert/strict';
import { type Client } from 'xrpl';
import { CAPABILITIES } from './issuer.js';
export const ISSUER_ADDRESS = 'rwtSKPNxCCKaLRpTgpYnWgZ8t2DBw8vXgo';
export const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233';
export interface DemoResult { issuanceId: string; holders: Record<'A' | 'B' | 'C', string> }
export async function verify(client: Client, result: DemoResult): Promise<unknown> {
  const ledger = (await client.request({command:'ledger', ledger_index:'validated'})).result;
  assert.equal(ledger.validated, true);
  const ledgerIndex = ledger.ledger_index;
  const issuance = (await client.request({command:'ledger_entry', ledger_index:ledgerIndex, mpt_issuance:result.issuanceId})).result;
  assert.equal(issuance.validated, true);
  assert.equal(issuance.node.LedgerEntryType, 'MPTokenIssuance');
  const issue = issuance.node as unknown as Record<string, unknown>;
  assert.equal(issue.Issuer, ISSUER_ADDRESS);
  assert.equal(issue.Flags, CAPABILITIES);
  assert.equal(issue.OutstandingAmount, '1200');
  assert.equal(issue.AssetScale ?? 0, 0);
  const holders: Record<string, unknown> = {};
  for (const name of ['A','B','C'] as const) {
    const response = (await client.request({command:'ledger_entry', ledger_index:ledgerIndex, mptoken:{mpt_issuance_id:result.issuanceId, account:result.holders[name]}})).result;
    assert.equal(response.validated, true);
    const node = response.node as unknown as {LedgerEntryType:string; MPTAmount?:string; Flags:number};
    assert.equal(node.LedgerEntryType, 'MPToken');
    assert.equal(node.MPTAmount ?? '0', {A:'500', B:'700', C:'0'}[name]);
    assert.equal(node.Flags, {A:2, B:3, C:0}[name]);
    holders[name] = {address:result.holders[name], balance:node.MPTAmount ?? '0', authorized:!!(node.Flags & 2), frozen:!!(node.Flags & 1)};
  }
  return {network:'testnet', ledgerIndex, ledgerHash:ledger.ledger_hash, issuanceId:result.issuanceId, issuer:ISSUER_ADDRESS, issuance:issue, holders};
}
