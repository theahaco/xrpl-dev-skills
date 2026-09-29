import assert from 'node:assert/strict';
import type { Client } from 'xrpl';
import { CAPABILITIES, assertTestnet } from './issuer.js';

export interface DemoResult { issuanceId:string; holders:Record<'A'|'B'|'C',string> }
export const ISSUER_ADDRESS = 'rJ1UNnBGHY83XddoTMZstNKMvH6Esvi9Mx';
export async function verify(client: Client, result: DemoResult): Promise<unknown> {
  await assertTestnet(client);
  const ledger = await client.getLedgerIndex();
  const issuance = await client.request({command:'ledger_entry',mpt_issuance:result.issuanceId,ledger_index:ledger});
  const i = issuance.result.node;
  const ledgerHash = (issuance.result as unknown as {ledger_hash:string}).ledger_hash;
  assert.match(ledgerHash,/^[A-F0-9]{64}$/);
  assert(issuance.result.validated);
  assert.equal(i.LedgerEntryType,'MPTokenIssuance');
  assert(i.LedgerEntryType === 'MPTokenIssuance');
  assert.equal(i.Issuer,ISSUER_ADDRESS); assert.equal(i.Flags,CAPABILITIES);
  assert.equal(i.OutstandingAmount,'1200'); assert.equal(i.AssetScale ?? 0,0);
  const holders: Record<string,unknown> = {};
  for (const [name,address] of Object.entries(result.holders)) {
    const r = await client.request({command:'ledger_entry',mptoken:{mpt_issuance_id:result.issuanceId,account:address},ledger_index:ledger});
    assert(r.result.validated); assert.equal((r.result as unknown as {ledger_hash:string}).ledger_hash,ledgerHash);
    const h = r.result.node as unknown as Record<string,unknown>;
    assert.equal(h['LedgerEntryType'],'MPToken'); assert.equal(h['Account'],address);
    assert.equal(h['MPTAmount'] ?? '0',name === 'A' ? '500' : name === 'B' ? '700' : '0');
    assert.equal(Number(h['Flags']) & 2,name === 'C' ? 0 : 2);
    if (name !== 'C') assert.equal(Number(h['Flags']) & 1,name === 'B' ? 1 : 0);
    holders[name] = h;
  }
  const account = await client.request({command:'account_info',account:ISSUER_ADDRESS,ledger_index:ledger});
  assert(account.result.account_data.Flags & 0x01000000);
  const preauth = await client.request({command:'account_objects',account:ISSUER_ADDRESS,type:'deposit_preauth',ledger_index:ledger});
  assert.equal(preauth.result.account_objects.length,0); assert.equal(preauth.result.marker,undefined);
  return {verifiedAt:new Date().toISOString(),ledger,ledgerHash,issuance:i,holders,issuerAccount:account.result.account_data};
}
