import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client } from 'xrpl';
import { CAPABILITIES, MptIssuer } from './issuer.js';
import { preflight, Submitter, TESTNET } from './ledger.js';
import { Store } from './store.js';
export const ISSUER = 'rakJkHNbLGejFB3GZ9XRaYCzeVGHTVuoez';
export interface Result { issuanceId: string; holders: { A: string; B: string; C: string } }
export async function verify(issuer: MptIssuer, result: Result) {
  const ledger = await issuer.submitter.client.getLedgerIndex();
  const [token, A, B, C] = await Promise.all([issuer.issuance(ledger), ...Object.values(result.holders).map(h => issuer.holder(h, ledger))]);
  assert.equal(token.Issuer, ISSUER);
  assert.equal(token.Flags, CAPABILITIES);
  assert.equal(token.OutstandingAmount, '1200');
  assert.equal(token.AssetScale ?? 0, 0);
  assert.equal(A?.MPTAmount, '500'); assert.equal(A.Flags, 2);
  assert.equal(B?.MPTAmount, '700'); assert.equal(B.Flags, 3);
  assert.equal(C?.MPTAmount ?? '0', '0'); assert.equal((C?.Flags ?? 0) & 2, 0);
  return { ledger, checkedAt: new Date().toISOString(), issuance: token, holders: { A, B, C } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new Client(TESTNET);
  const store = new Store('.private/verify.sqlite');
  try {
    await client.connect(); await preflight(client);
    const result = JSON.parse(readFileSync('result.json', 'utf8')) as Result;
    const issuer = new MptIssuer(new Submitter(client, store), { classicAddress: ISSUER, sign() { throw new Error('Read only'); } }, result.issuanceId);
    const state = await verify(issuer, result);
    writeFileSync('verification.json', JSON.stringify(state, null, 2) + '\n');
    console.log(`Verified final state at ledger ${state.ledger}`);
  } finally { await client.disconnect(); store.close(); }
}
