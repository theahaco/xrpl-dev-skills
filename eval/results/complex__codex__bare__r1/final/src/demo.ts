import { Client, Wallet, type SubmittableTransaction } from 'xrpl';
import { open, readFile, writeFile, rename } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { MptIssuer, TransactionRunner, LedgerFailure, CAPABILITIES, type PolicyStore } from './issuer.js';

const client = new Client('wss://s.altnet.rippletest.net:51233');
const issuer = Wallet.fromSeed(process.env.ISSUER_SEED ?? '');
assert.equal(issuer.classicAddress,'rUTfAPXoR2Pi5iUEtKYDeozNnQ4UmZQuzC');
async function durableAppend(path: string, data: unknown) {
  const file = await open(path,'a',0o600);
  try { await file.writeFile(JSON.stringify(data)+'\n'); await file.sync(); } finally { await file.close(); }
}
const runner = new TransactionRunner(client,event => durableAppend('audit.jsonl',event));
const bans = new Set<string>();
try { for (const line of (await readFile('bans.jsonl','utf8')).trim().split('\n').filter(Boolean)) bans.add(JSON.parse(line) as string); }
catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
const policy: PolicyStore = {
  async isBanned(id,holder) { return bans.has(`${id}:${holder}`); },
  async ban(id,holder) { const key = `${id}:${holder}`; await durableAppend('bans.jsonl',key); bans.add(key); }
};
// Refuse to silently duplicate a partly completed run. Recover using audit.jsonl first.
const secrets = await open('.demo-secrets.json','wx',0o600);
const A = Wallet.generate(), B = Wallet.generate(), C = Wallet.generate();
await secrets.writeFile(JSON.stringify({A:A.seed,B:B.seed,C:C.seed})); await secrets.sync(); await secrets.close();
try {
  await client.connect();
  for (const holder of [A,B,C]) await runner.submit(issuer,{TransactionType:'Payment',Account:issuer.classicAddress,Destination:holder.classicAddress,Amount:'10000000'});
  const token = await MptIssuer.create(runner,issuer,policy);
  await writeFile('demo-progress.json',JSON.stringify({issuanceId:token.issuanceId,holders:{A:A.classicAddress,B:B.classicAddress,C:C.classicAddress}},null,2));
  const pay = (from: Wallet,to: Wallet,value='1'): SubmittableTransaction => ({TransactionType:'Payment',Account:from.classicAddress,Destination:to.classicAddress,Amount:{mpt_issuance_id:token.issuanceId,value}});
  async function blocked(label: string, from: Wallet, to: Wallet, codes: string[]) {
    try { await runner.submit(from,pay(from,to)); assert.fail(`${label} unexpectedly succeeded`); }
    catch (error) { if (!(error instanceof LedgerFailure) || !codes.includes(error.code)) throw error; console.log(`${label}: ${error.code}`); }
  }
  for (const holder of [A,B,C]) await runner.submit(holder,{TransactionType:'MPTokenAuthorize',Account:holder.classicAddress,MPTokenIssuanceID:token.issuanceId});
  await blocked('Unapproved receipt',issuer,A,['tecNO_AUTH']);
  for (const holder of [A,B,C]) await token.approve(holder.classicAddress);
  await token.issue(A.classicAddress,'500'); await token.issue(B.classicAddress,'1000'); await token.issue(C.classicAddress,'100');
  await token.freezeHolder(A.classicAddress);
  await blocked('Frozen holder sends',A,C,['tecLOCKED']);
  await blocked('Frozen holder receives',C,A,['tecLOCKED']);
  await token.unfreezeHolder(A.classicAddress);
  await runner.submit(A,pay(A,C)); await runner.submit(C,pay(C,A));
  await token.clawback(B.classicAddress,'300'); await token.freezeHolder(B.classicAddress);
  await token.freezeGlobal();
  await blocked('Global freeze',A,C,['tecLOCKED']);
  await token.unfreezeGlobal();
  await runner.submit(A,pay(A,C)); await runner.submit(C,pay(C,A));
  await token.ban(C.classicAddress);
  await token.ban(C.classicAddress); // Idempotent resume.
  await blocked('Banned holder receives',A,C,['tecNO_AUTH']);
  await blocked('Issuer cannot pay banned holder',issuer,C,['tecNO_AUTH']);
  await assert.rejects(token.approve(C.classicAddress),/banned/);
  // Deleting and re-creating the holder object must not bypass issuer authorization.
  await runner.submit(C,{TransactionType:'MPTokenAuthorize',Account:C.classicAddress,MPTokenIssuanceID:token.issuanceId,Flags:1});
  await runner.submit(C,{TransactionType:'MPTokenAuthorize',Account:C.classicAddress,MPTokenIssuanceID:token.issuanceId});
  await blocked('Recreated banned holder receives',A,C,['tecNO_AUTH']);
  const ledger = (await client.request({command:'ledger',ledger_index:'validated'})).result.ledger_index;
  const issuance = await token.issuance(ledger);
  const states = await Promise.all([A,B,C].map(h => token.holder(h.classicAddress,ledger)));
  assert.equal(issuance.Flags,CAPABILITIES); assert.equal(issuance.OutstandingAmount,'1200');
  for (const [i,balance,flags] of [[0,'500',2],[1,'700',3],[2,'0',0]] as const) {
    assert.equal(states[i]?.MPTAmount,balance); assert.equal(states[i]?.Flags,flags);
  }
  await writeFile('verification.json',JSON.stringify({ledger,issuance,holders:states},null,2));
  await rename('demo-progress.json','result.json');
  console.log('Verified final ledger state. Written result.json');
} finally { await client.disconnect(); }
