import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from 'xrpl';
import { CAPABILITIES, MptIssuer, TESTNET, TransactionRunner } from './issuer.js';
import { atomicJson, type State } from './store.js';

export interface DemoResult { issuanceId: string; holders: { A: string; B: string; C: string } }
export const ISSUER_ADDRESS = 'rNGckWk5JV2Y3UvY4CQdLMBKP5VBivkDUU';
export async function verify(client: Client, result: DemoResult) {
  const state: State = { version: 1, transactions: {}, bans: {} };
  const runner = new TransactionRunner(client, { state, save: async () => undefined });
  await runner.checkNetwork();
  const issuer = new MptIssuer(runner, { address: ISSUER_ADDRESS, sign: async () => { throw new Error('Read-only'); } }, result.issuanceId);
  const ledger = await client.getLedgerIndex();
  const issuance = await issuer.issuance(ledger);
  const A = await issuer.holder(result.holders.A, ledger);
  const B = await issuer.holder(result.holders.B, ledger);
  const C = await issuer.holder(result.holders.C, ledger);
  assert.equal(issuance.Issuer, ISSUER_ADDRESS);
  assert.equal(issuance.Flags, CAPABILITIES);
  assert.equal(issuance.AssetScale ?? 0, 0);
  assert.equal(issuance.OutstandingAmount, '1200');
  assert.equal(A?.MPTAmount, '500'); assert.equal(A.Flags & 3, 2);
  assert.equal(B?.MPTAmount, '700'); assert.equal(B.Flags & 3, 3);
  assert.equal(C?.MPTAmount ?? '0', '0'); assert.equal((C?.Flags ?? 0) & 2, 0);
  return { verifiedAt: new Date().toISOString(), ledgerIndex: ledger, issuance, A, B, C };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new Client(TESTNET);
  try {
    await client.connect();
    const result = JSON.parse(await readFile('result.json', 'utf8')) as DemoResult;
    const evidence = await verify(client, result);
    await atomicJson('verification.json', evidence);
    console.log(`Verified final ledger state at ledger ${evidence.ledgerIndex}`);
  } finally { await client.disconnect(); }
}
