import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Client, Wallet, type SubmittableTransaction } from 'xrpl';
import { MptIssuer, TransactionRunner, LedgerFailure, TESTNET } from './issuer.js';
import { SqliteStore } from './storage.js';
import { verify, ISSUER, type Result } from './verify.js';

const seed = process.env.ISSUER_SEED;
if (!seed) throw new Error('Set ISSUER_SEED to the testnet issuer seed');
const wallet = Wallet.fromSeed(seed);
assert.equal(wallet.classicAddress, ISSUER);
const client = new Client(TESTNET, { timeout: 20000 });
const store = new SqliteStore('.private/demo.sqlite');
store.assertNoPending();
const interruptedStep = store.get<string>('runningStep');
if (interruptedStep) throw new Error(`Interrupted demo step: ${interruptedStep}. Reconcile its receipts before clearing runningStep; do not blindly repeat a payment.`);
const runner = new TransactionRunner(client, store);
async function step(name: string, action: () => Promise<void>): Promise<void> {
  if (store.get<boolean>(name)) return;
  console.log(name); store.put('runningStep', name);
  await action(); store.put(name, true); store.put('runningStep', null);
}
try {
  await client.connect(); await runner.assertTestnet();
  let seeds = store.get<Record<'A' | 'B' | 'C', string>>('holderSeeds');
  if (!seeds) {
    seeds = { A: Wallet.generate().seed!, B: Wallet.generate().seed!, C: Wallet.generate().seed! };
    store.put('holderSeeds', seeds);
  }
  const holders = { A: Wallet.fromSeed(seeds.A), B: Wallet.fromSeed(seeds.B), C: Wallet.fromSeed(seeds.C) };
  for (const [name, holder] of Object.entries(holders)) await step(`fund ${name}`, async () => {
    await runner.submit(wallet, { TransactionType: 'Payment', Account: ISSUER, Destination: holder.classicAddress, Amount: '10000000' });
  });
  let id = store.get<string>('issuanceId');
  if (!id) {
    // Prevent accidental second issuance after a crash between validation and checkpoint.
    const created = store.receipts() as { transaction: SubmittableTransaction; receipt: { code: string; meta: { mpt_issuance_id?: string } } | null }[];
    id = created.find(r => r.transaction.TransactionType === 'MPTokenIssuanceCreate' && r.receipt?.code === 'tesSUCCESS')?.receipt?.meta.mpt_issuance_id;
    if (!id) id = (await MptIssuer.create(runner, wallet, store)).issuanceId;
    store.put('issuanceId', id);
  }
  const token = new MptIssuer(runner, wallet, id, store);
  const { A, B, C } = holders;
  const payment = (from: Wallet, to: Wallet, value = '1'): SubmittableTransaction => ({ TransactionType: 'Payment', Account: from.classicAddress, Destination: to.classicAddress, Amount: { mpt_issuance_id: id, value } });
  async function rejected(name: string, from: Wallet, to: Wallet, expected: string[]): Promise<void> {
    await step(name, async () => {
      await assert.rejects(runner.submit(from, payment(from, to)), error => error instanceof LedgerFailure && expected.includes(error.receipt.code));
    });
  }
  for (const [name, holder] of Object.entries(holders)) await step(`opt in ${name}`, async () => {
    await runner.submit(holder, { TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress, MPTokenIssuanceID: id });
  });
  await rejected('unapproved mint rejected', wallet, A, ['tecNO_AUTH']);
  for (const [name, holder] of Object.entries(holders)) await step(`approve ${name}`, () => token.approve(holder.classicAddress));
  await step('mint A 500', () => token.mint(A.classicAddress, '500'));
  await step('mint B 1000', () => token.mint(B.classicAddress, '1000'));
  await step('mint C 200', () => token.mint(C.classicAddress, '200'));
  await step('freeze A', () => token.freeze(A.classicAddress));
  await rejected('frozen A send rejected', A, B, ['tecLOCKED']);
  await rejected('frozen A receive rejected', B, A, ['tecLOCKED']);
  await step('unfreeze A', () => token.unfreeze(A.classicAddress));
  await step('A sends after unfreeze', async () => { await runner.submit(A, payment(A, B)); });
  await step('restore A balance', async () => { await runner.submit(B, payment(B, A)); });
  await step('claw back B 300', () => token.clawback(B.classicAddress, '300'));
  await step('freeze B', () => token.freeze(B.classicAddress));
  await step('freeze all', () => token.freezeAll());
  await rejected('global freeze send rejected', A, C, ['tecLOCKED']);
  await rejected('global freeze reverse rejected', C, A, ['tecLOCKED']);
  await step('unfreeze all', () => token.unfreezeAll());
  await step('A sends after global unfreeze', async () => { await runner.submit(A, payment(A, C)); });
  await step('restore A after global unfreeze', async () => { await runner.submit(C, payment(C, A)); });
  await step('ban C', () => token.ban(C.classicAddress));
  await rejected('banned C receive rejected', A, C, ['tecNO_AUTH', 'tecLOCKED']);
  await rejected('issuer cannot pay banned C', wallet, C, ['tecNO_AUTH', 'tecLOCKED']);
  await step('ban remains on repeat', () => token.ban(C.classicAddress));
  await step('banned C cannot be reapproved through module', async () => { await assert.rejects(token.approve(C.classicAddress), /banned/); });
  // Prove the protocol limitation explicitly, restoring A to 500 afterward.
  await step('freeze A to demonstrate redemption exception', () => token.freeze(A.classicAddress));
  await step('frozen A can redeem to issuer', async () => { await runner.submit(A, payment(A, wallet)); });
  await step('unfreeze A after redemption exception', () => token.unfreeze(A.classicAddress));
  await step('restore A after frozen redemption', () => token.mint(A.classicAddress, '1'));
  await step('global freeze to demonstrate redemption exception', () => token.freezeAll());
  await step('A can redeem during global freeze', async () => { await runner.submit(A, payment(A, wallet)); });
  await step('global unfreeze after redemption exception', () => token.unfreezeAll());
  await step('restore A after global frozen redemption', () => token.mint(A.classicAddress, '1'));
  const result: Result = { issuanceId: id, holders: { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress } };
  const report = await verify(client, result);
  await writeFile('verification.json', JSON.stringify(report, null, 2) + '\n');
  await writeFile('audit.json', JSON.stringify(store.receipts(), null, 2) + '\n');
  await writeFile('result.json', JSON.stringify(result, null, 2) + '\n');
  console.log('Demo complete. Final validated balances: A=500, B=700, C=0.');
} finally { await client.disconnect(); store.close(); }
