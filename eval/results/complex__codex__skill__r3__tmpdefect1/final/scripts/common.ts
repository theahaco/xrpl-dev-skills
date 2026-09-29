import assert from 'node:assert/strict';
import { Client } from 'xrpl';
import { ISSUANCE_FLAGS, XrplLedgerReader } from '../src/index.js';

export const ENDPOINT = 'wss://s.altnet.rippletest.net:51233';
export const ISSUER = 'rnKzFF5SvNHU3pNF66YMPSBHR7H75DQZdy';
export interface Result { issuanceId: string; holders: { A: string; B: string; C: string } }

export async function verify(client: Client, result: Result) {
  const ledger = new XrplLedgerReader(client);
  const network = (await client.request({ command: 'server_info' })).result.info;
  assert.equal(network.network_id, 1);
  const index = network.validated_ledger?.seq;
  assert.ok(index);
  const issuance = await ledger.issuance(result.issuanceId, index);
  assert.equal(issuance.Issuer, ISSUER);
  assert.equal(issuance.Flags, ISSUANCE_FLAGS);
  assert.equal(issuance.AssetScale ?? 0, 0);
  assert.equal(issuance.OutstandingAmount, '1200');
  const A = await ledger.holding(result.issuanceId, result.holders.A, index);
  const B = await ledger.holding(result.issuanceId, result.holders.B, index);
  const C = await ledger.holding(result.issuanceId, result.holders.C, index);
  assert.ok(A); assert.ok(B); assert.ok(C);
  assert.equal(A.MPTAmount, '500'); assert.equal(A.Flags, 2);
  assert.equal(B.MPTAmount, '700'); assert.equal(B.Flags, 3);
  assert.equal(C.MPTAmount ?? '0', '0'); assert.equal(C.Flags & 2, 0);
  assert.equal(C.Flags & 1, 1);
  return { network: 1, ledgerIndex: index, ledgerHash: network.validated_ledger?.hash, issuance, holders: { A, B, C } };
}
