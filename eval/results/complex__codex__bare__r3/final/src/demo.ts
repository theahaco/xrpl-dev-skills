import assert from 'node:assert/strict';
import { mkdir, open, readFile, writeFile, unlink } from 'node:fs/promises';
import { Client, Wallet, type Payment } from 'xrpl';
import { Issuer, Submitter, TransactionFailure, CONTROL_FLAGS } from './issuer.js';
import { FileStore } from './storage.js';

const dir = '.private';
await mkdir(dir, { recursive: true, mode: 0o700 });
const lock = await open(`${dir}/demo.lock`, 'wx', 0o600);
const client = new Client('wss://s.altnet.rippletest.net:51233', { maxFeeXRP: '0.001' });
try {
  const seed = process.env.ISSUER_SEED;
  if (!seed) throw new Error('Set ISSUER_SEED');
  const wallet = Wallet.fromSeed(seed);
  assert.equal(wallet.classicAddress, 'rUUyBzBvySZY8NSEysNkFgjk9wiro4Qqx7');
  const store = new FileStore(dir);
  await store.assertNoPending();
  await client.connect();
  const submitter = new Submitter(client, wallet, store);
  type State = { seeds: Record<'A' | 'B' | 'C', string>; issuanceId?: string; done: string[] };
  let state: State;
  try { state = JSON.parse(await readFile(`${dir}/demo-state.json`, 'utf8')) as State; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    state = { seeds: { A: Wallet.generate().seed!, B: Wallet.generate().seed!, C: Wallet.generate().seed! }, done: [] };
  }
  const save = async () => { const f = await open(`${dir}/demo-state.json`, 'w', 0o600); try { await f.writeFile(JSON.stringify(state)); await f.sync(); } finally { await f.close(); } };
  await save();
  const holders = { A: Wallet.fromSeed(state.seeds.A), B: Wallet.fromSeed(state.seeds.B), C: Wallet.fromSeed(state.seeds.C) };
  const step = async (name: string, fn: () => Promise<unknown>) => {
    if (state.done.includes(name)) return;
    // A crash during a step requires explicit reconciliation, never a blind replay.
    await writeFile(`${dir}/active-step`, name, { flag: 'wx', mode: 0o600 });
    console.log(name);
    await fn(); state.done.push(name); await save(); await unlink(`${dir}/active-step`);
  };
  for (const [name, h] of Object.entries(holders)) await step(`fund ${name}`, () => submitter.submit({ TransactionType: 'Payment', Account: wallet.classicAddress, Destination: h.classicAddress, Amount: '10000000' }));
  await step('create issuance', async () => { state.issuanceId = await Issuer.create(submitter); await save(); });
  assert(state.issuanceId);
  const issuer = new Issuer(submitter, state.issuanceId, store);
  await issuer.verifyConfiguration();
  const pay = (from: Wallet, to: Wallet, value = '1') => new Submitter(client, from, store).submit({ TransactionType: 'Payment', Account: from.classicAddress, Destination: to.classicAddress, Amount: { mpt_issuance_id: issuer.issuanceId, value } } satisfies Payment);
  const rejected = async (fn: () => Promise<unknown>, codes: string[]) => {
    try { await fn(); assert.fail('Payment unexpectedly succeeded'); }
    catch (e) { if (!(e instanceof TransactionFailure)) throw e; assert(codes.includes(e.receipt.code), `Unexpected failure ${e.receipt.code}`); }
  };
  for (const [name, h] of Object.entries(holders)) {
    await step(`opt in ${name}`, () => new Submitter(client, h, store).submit({ TransactionType: 'MPTokenAuthorize', Account: h.classicAddress, MPTokenIssuanceID: issuer.issuanceId }));
    await step(`reject unapproved ${name}`, () => rejected(() => pay(wallet, h), ['tecNO_AUTH']));
    await step(`approve ${name}`, () => issuer.approve(h.classicAddress));
  }
  await step('mint A 500', () => issuer.mint(holders.A.classicAddress, '500'));
  await step('mint B 1000', () => issuer.mint(holders.B.classicAddress, '1000'));
  await step('mint C 200', () => issuer.mint(holders.C.classicAddress, '200'));
  await step('freeze A', () => issuer.freezeHolder(holders.A.classicAddress));
  await step('reject A outgoing', () => rejected(() => pay(holders.A, holders.B), ['tecLOCKED']));
  await step('reject A incoming', () => rejected(() => pay(holders.B, holders.A), ['tecLOCKED']));
  await step('unfreeze A', () => issuer.freezeHolder(holders.A.classicAddress, false));
  await step('A transfer after unfreeze', () => pay(holders.A, holders.B));
  await step('restore A balance', () => pay(holders.B, holders.A));
  await step('clawback B 300', () => issuer.clawback(holders.B.classicAddress, '300'));
  await step('global freeze', () => issuer.freezeAll());
  await step('reject globally frozen movement', () => rejected(() => pay(holders.A, holders.B), ['tecLOCKED']));
  await step('global unfreeze', () => issuer.freezeAll(false));
  await step('transfer after global unfreeze', () => pay(holders.A, holders.B));
  await step('restore A after global unfreeze', () => pay(holders.B, holders.A));
  await step('freeze B', () => issuer.freezeHolder(holders.B.classicAddress));
  await step('ban C', () => issuer.ban(holders.C.classicAddress));
  await step('reject banned C peer receipt', () => rejected(() => pay(holders.A, holders.C), ['tecNO_AUTH']));
  await step('reject banned C issuer receipt', () => rejected(() => pay(wallet, holders.C), ['tecNO_AUTH']));
  await step('ban C again', () => issuer.ban(holders.C.classicAddress));
  await assert.rejects(issuer.approve(holders.C.classicAddress), /banned/);
  const ledger = await client.getLedgerIndex();
  const [i, a, b, c] = await Promise.all([issuer.issuance(ledger), issuer.holding(holders.A.classicAddress, ledger), issuer.holding(holders.B.classicAddress, ledger), issuer.holding(holders.C.classicAddress, ledger)]);
  assert.equal(i.Flags & CONTROL_FLAGS, CONTROL_FLAGS); assert.equal(i.Flags & 1, 0); assert.equal(i.OutstandingAmount, '1200');
  assert(a && b && c);
  assert.equal(a.MPTAmount, '500'); assert.equal(a.Flags & 3, 2);
  assert.equal(b.MPTAmount, '700'); assert.equal(b.Flags & 3, 3);
  assert.equal(c.MPTAmount, '0'); assert.equal(c.Flags & 2, 0);
  await writeFile('verification.json', JSON.stringify({ ledger, issuance: i, holders: { A: a, B: b, C: c }, transactions: (await store.records('transactions.jsonl')).filter(e => e.kind === 'validated') }, null, 2) + '\n');
  await writeFile('result.json', JSON.stringify({ issuanceId: issuer.issuanceId, holders: Object.fromEntries(Object.entries(holders).map(([k, v]) => [k, v.classicAddress])) }, null, 2) + '\n');
  console.log(`Verified requested state at validated ledger ${ledger}`);
} finally { await client.disconnect(); await lock.close(); await unlink(`${dir}/demo.lock`); }
