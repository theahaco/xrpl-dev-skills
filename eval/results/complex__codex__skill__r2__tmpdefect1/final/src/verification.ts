import assert from 'node:assert/strict';
import { CONTROL_FLAGS, MptIssuer } from './issuer.js';
export interface DemoResult { issuanceId: string; holders: { A: string; B: string; C: string } }
export async function verify(issuer: MptIssuer, result: DemoResult) {
  const ledger = await issuer.executor.client.request({ command: 'ledger', ledger_index: 'validated' });
  const hash = ledger.result.ledger_hash;
  const issuance = await issuer.issuance(hash);
  const [A, B, C] = await Promise.all([issuer.holder(result.holders.A, hash), issuer.holder(result.holders.B, hash), issuer.holder(result.holders.C, hash)]);
  assert.equal(issuance.Flags, CONTROL_FLAGS);
  assert.equal(issuance.OutstandingAmount, '1200');
  assert.deepEqual(A, { exists: true, balance: '500', authorized: true, frozen: false });
  assert.deepEqual(B, { exists: true, balance: '700', authorized: true, frozen: true });
  assert.equal(C.balance, '0');
  assert.equal(C.authorized, false);
  return { ledgerHash: hash, ledgerIndex: ledger.result.ledger_index, issuer: issuance.Issuer, flags: issuance.Flags, outstandingAmount: issuance.OutstandingAmount, A, B, C };
}
