import assert from 'node:assert/strict';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { Client, Wallet, xrpToDrops } from 'xrpl';
import { Executor, LedgerFailure, MptIssuer, TESTNET } from './issuer.js';
import { FileStore } from './storage.js';
import { verify, type DemoResult } from './verification.js';

const seed = process.env.ISSUER_SEED;
if (!seed) throw new Error('Set ISSUER_SEED in the environment');
const wallet = Wallet.fromSeed(seed);
assert.equal(wallet.classicAddress, 'rNbSd1jtyvmwv5Pj91BV2iYUhT77Vo2E5u');
await mkdir('.runtime', { recursive: true, mode: 0o700 });
// Exclusive run lock. A stale lock requires transaction reconciliation before removal.
const lock = await open('.runtime/demo.lock', 'wx', 0o600);
const store = new FileStore('.runtime/events.jsonl');
const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
const issuerExecutor = new Executor(client, wallet, store);
async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  const events = await store.events();
  const completed = events.find(e => e.type === 'step-done' && e.name === name);
  if (completed) return completed.value as T;
  const start = events.findLastIndex(e => e.type === 'step-start' && e.name === name);
  const reconciled = events.findLastIndex(e => e.type === 'step-reconciled' && e.name === name);
  if (start > reconciled) throw new Error(`Interrupted step ${name}: reconcile journal before resuming`);
  await store.append({ type: 'step-start', name });
  console.log(name);
  const value = await work();
  await store.append({ type: 'step-done', name, value });
  return value;
}
try {
  await client.connect();
  const info = (await client.request({ command: 'server_info' })).result.info;
  assert.equal(info.network_id, 1);
  const reserve = info.validated_ledger;
  assert.ok(reserve);
  assert.ok(reserve.reserve_base_xrp + reserve.reserve_inc_xrp + 0.1 < 5, 'Holder funding insufficient for reserves');
  console.log(`Reserves: ${reserve.reserve_base_xrp} XRP base + ${reserve.reserve_inc_xrp} XRP/object`);
  const accounts = await step('generate encrypted holder wallets', async () => {
    const holders = [Wallet.generate(), Wallet.generate(), Wallet.generate()];
    const salt = randomBytes(16), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', scryptSync(seed, salt, 32), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(holders.map(w => w.seed))), cipher.final()]);
    await writeFile('.runtime/holders.enc.json', JSON.stringify({ salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') }), { mode: 0o600 });
    return holders.map(w => w.classicAddress);
  });
  const encrypted = JSON.parse(await readFile('.runtime/holders.enc.json', 'utf8')) as Record<string, string>;
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(seed, Buffer.from(encrypted.salt!, 'hex'), 32), Buffer.from(encrypted.iv!, 'hex'));
  decipher.setAuthTag(Buffer.from(encrypted.tag!, 'hex'));
  const seeds = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext!, 'hex')), decipher.final()]).toString()) as string[];
  const holders = seeds.map(s => Wallet.fromSeed(s));
  assert.deepEqual(holders.map(w => w.classicAddress), accounts);
  const [A, B, C] = holders;
  assert.ok(A && B && C);
  const [a, b, c] = [A, B, C].map(w => new Executor(client, w, store));
  assert.ok(a && b && c);
  for (const holder of holders) await step(`fund ${holder.classicAddress}`, async () => {
    const account = (await client.request({ command: 'account_info', account: wallet.classicAddress, ledger_index: 'validated' })).result.account_data;
    const needed = 5 + reserve.reserve_base_xrp + reserve.reserve_inc_xrp * (account.OwnerCount + 1) + 0.1;
    assert.ok(BigInt(account.Balance) > BigInt(xrpToDrops(needed)), 'Issuer funding insufficient');
    await issuerExecutor.send({ TransactionType: 'Payment', Account: wallet.classicAddress, Destination: holder.classicAddress, Amount: xrpToDrops('5') });
  });
  const id = await step('create issuance with all controls', async () => (await MptIssuer.create(issuerExecutor, store)).issuanceId);
  const issuer = await MptIssuer.open(issuerExecutor, id, store);
  const result: DemoResult = { issuanceId: id, holders: { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress } };
  await writeFile('.runtime/manifest.json', JSON.stringify(result, null, 2));
  async function payment(from: Executor, to: string, value = '1') {
    await from.send({ TransactionType: 'Payment', Account: from.signer.classicAddress, Destination: to, Amount: { mpt_issuance_id: id, value } });
  }
  async function blocked(name: string, from: Executor, to: string, codes: string[]) {
    await step(name, async () => {
      try { await payment(from, to); } catch (error) {
        if (error instanceof LedgerFailure && codes.includes(error.receipt.code)) return error.receipt;
        throw error;
      }
      throw new Error(`Prohibited payment unexpectedly succeeded: ${name}`);
    });
  }
  async function redemptionException(name: string, from: Executor) {
    await step(name, async () => {
      const simulation = await client.request({ command: 'simulate', tx_json: { TransactionType: 'Payment', Account: from.signer.classicAddress, Destination: wallet.classicAddress, Amount: { mpt_issuance_id: id, value: '1' } } });
      assert.equal(simulation.result.engine_result, 'tesSUCCESS', 'Native MPT freeze redemption semantics changed');
      return { simulatedOnly: true, code: simulation.result.engine_result, ledgerIndex: simulation.result.ledger_index, limitation: 'Native locks permit redemption directly to the issuer' };
    });
  }
  for (const holder of [a, b, c]) await step(`opt in ${holder.signer.classicAddress}`, async () => {
    await holder.send({ TransactionType: 'MPTokenAuthorize', Account: holder.signer.classicAddress, MPTokenIssuanceID: id });
  });
  await blocked('reject issuance to unapproved A', issuerExecutor, A.classicAddress, ['tecNO_AUTH']);
  for (const holder of holders) await step(`approve ${holder.classicAddress}`, () => issuer.approve(holder.classicAddress));
  await step('mint A 500', () => issuer.mint(A.classicAddress, '500'));
  await step('mint B 1000', () => issuer.mint(B.classicAddress, '1000'));
  await step('mint C 200', () => issuer.mint(C.classicAddress, '200'));
  await step('freeze A', () => issuer.freeze(A.classicAddress));
  await redemptionException('native holder freeze redemption exception', a);
  await blocked('frozen A cannot send', a, B.classicAddress, ['tecLOCKED']);
  await blocked('frozen A cannot receive', b, A.classicAddress, ['tecLOCKED']);
  await step('unfreeze A', () => issuer.unfreeze(A.classicAddress));
  await step('A can send after unfreeze', () => payment(a, B.classicAddress));
  await step('A can receive after unfreeze', () => payment(b, A.classicAddress));
  await step('claw back B 300', () => issuer.clawback(B.classicAddress, '300'));
  await step('global freeze', () => issuer.setGlobalFreeze(true));
  await redemptionException('native global freeze redemption exception', a);
  await blocked('global freeze blocks A to B', a, B.classicAddress, ['tecLOCKED']);
  await blocked('global freeze blocks B to A', b, A.classicAddress, ['tecLOCKED']);
  await step('global unfreeze', () => issuer.setGlobalFreeze(false));
  await step('transfer after global unfreeze', () => payment(a, B.classicAddress));
  await step('restore balances after global unfreeze', () => payment(b, A.classicAddress));
  await step('ban C', () => issuer.ban(C.classicAddress));
  await blocked('banned C cannot receive from holder', a, C.classicAddress, ['tecNO_AUTH']);
  await blocked('banned C cannot receive from issuer', issuerExecutor, C.classicAddress, ['tecNO_AUTH']);
  await step('C deletes zero balance holding', async () => { await c.send({ TransactionType: 'MPTokenAuthorize', Account: C.classicAddress, MPTokenIssuanceID: id, Flags: 1 }); });
  await step('C opts in again without issuer approval', async () => { await c.send({ TransactionType: 'MPTokenAuthorize', Account: C.classicAddress, MPTokenIssuanceID: id }); });
  await blocked('recreated C holding remains unauthorized', a, C.classicAddress, ['tecNO_AUTH']);
  await step('ban C is idempotent', () => issuer.ban(C.classicAddress));
  await step('ban prevents reapproval through issuer module', async () => { await assert.rejects(issuer.approve(C.classicAddress), /banned/); });
  await step('freeze B at end', () => issuer.freeze(B.classicAddress));
  await blocked('B cannot send at end', b, A.classicAddress, ['tecLOCKED']);
  await blocked('B cannot receive at end', a, B.classicAddress, ['tecLOCKED']);
  const verification = await verify(issuer, result);
  await writeFile('result.json', JSON.stringify(result, null, 2) + '\n');
  const events = await store.events();
  await writeFile('demo-report.json', JSON.stringify({ ...verification, transactions: events.filter(e => e.type === 'settled'), checks: events.filter(e => e.type === 'step-done') }, null, 2) + '\n');
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await client.disconnect();
  await lock.close();
  const { unlink } = await import('node:fs/promises');
  await unlink('.runtime/demo.lock');
}
