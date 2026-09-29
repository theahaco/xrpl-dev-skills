import assert from 'node:assert/strict';
import { Wallet, MPTokenAuthorizeFlags, type SubmittableTransaction } from 'xrpl';
import { Runtime, LedgerFailure, readJson, writeJson, type Signer } from './runtime.js';
import { MptIssuer } from './issuer.js';
import { verify, type Result } from './verification.js';
const ISSUER = 'r4ViabjxFwnJsJQNywFYx7Z6pmp5oFVzDG';
interface State { seeds: { A: string; B: string; C: string }; completed: string[]; issuanceId?: string }
const seed = process.env.ISSUER_SEED;
if (!seed) throw new Error('Set ISSUER_SEED in the environment');
const wallet = Wallet.fromSeed(seed);
assert.equal(wallet.classicAddress, ISSUER, 'Issuer seed/address mismatch');
const runtime = await Runtime.open('.private');
try {
  let state = await readJson<State>('.private/demo.json');
  if (!state) {
    state = { seeds: { A: Wallet.generate().seed!, B: Wallet.generate().seed!, C: Wallet.generate().seed! }, completed: [] };
    await writeJson('.private/demo.json', state);
  }
  const saved = state;
  const A = Wallet.fromSeed(saved.seeds.A), B = Wallet.fromSeed(saved.seeds.B), C = Wallet.fromSeed(saved.seeds.C);
  async function step(name: string, work: () => Promise<unknown>): Promise<void> {
    if (saved.completed.includes(name)) return;
    await work(); saved.completed.push(name); await writeJson('.private/demo.json', saved);
  }
  const send = (id: string, tx: SubmittableTransaction, signer: Signer) => runtime.run(() => runtime.send(id, tx, signer));
  for (const [name, holder] of [['A', A], ['B', B], ['C', C]] as const) {
    await step(`fund-${name}`, () => send(`fund-${name}`, { TransactionType: 'Payment', Account: ISSUER, Destination: holder.classicAddress, Amount: '10000000' }, wallet));
  }
  const issuer = saved.issuanceId ? await MptIssuer.attach(runtime, wallet, saved.issuanceId) : await MptIssuer.create(runtime, wallet, 'demo-token');
  saved.issuanceId = issuer.issuanceId; await writeJson('.private/demo.json', saved);
  const result: Result = { issuanceId: issuer.issuanceId, holders: { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress } };
  const payment = (from: Signer, to: string, value = '1'): SubmittableTransaction => ({
    TransactionType: 'Payment', Account: from.classicAddress, Destination: to, Amount: { mpt_issuance_id: issuer.issuanceId, value },
  });
  async function blocked(id: string, from: Signer, to: string, codes: string[]): Promise<void> {
    await step(id, async () => {
      await assert.rejects(send(id, payment(from, to), from), (e: unknown) => e instanceof LedgerFailure && codes.includes(e.code));
    });
  }
  for (const [name, holder] of [['A', A], ['B', B], ['C', C]] as const) {
    await step(`opt-in-${name}`, () => send(`opt-in-${name}`, issuer.optInTransaction(holder.classicAddress), holder));
  }
  await blocked('unapproved-C', wallet, C.classicAddress, ['tecNO_AUTH']);
  for (const [name, holder] of [['A', A], ['B', B], ['C', C]] as const) {
    await step(`approve-${name}`, () => issuer.approve(holder.classicAddress, `approve-${name}`));
  }
  await step('issue-A', () => issuer.issue(A.classicAddress, '500', 'issue-A'));
  await step('issue-B', () => issuer.issue(B.classicAddress, '1000', 'issue-B'));
  await step('issue-C', () => issuer.issue(C.classicAddress, '200', 'issue-C'));
  await step('clawback-B', () => issuer.clawback(B.classicAddress, '300', 'clawback-B'));
  await step('freeze-A', () => issuer.setHolderFreeze(A.classicAddress, true, 'freeze-A'));
  const lockErrors = ['tecLOCKED', 'tecPATH_PARTIAL', 'tecFROZEN'];
  await blocked('frozen-A-send', A, B.classicAddress, lockErrors);
  await blocked('frozen-A-receive', B, A.classicAddress, lockErrors);
  // Native issuer-originated payments bypass a holder lock on this testnet.
  // Record the observed exception, then reverse the one-unit probe via clawback.
  await step('native-issuer-lock-exception', () => send('frozen-A-issuance', payment(wallet, A.classicAddress), wallet));
  await step('reverse-issuer-lock-probe', () => issuer.clawback(A.classicAddress, '1', 'reverse-issuer-lock-probe'));
  await step('guard-frozen-A-issuance', () => assert.rejects(issuer.issue(A.classicAddress, '1', 'guard-frozen-A-issuance'), /freeze policy/));
  await blocked('frozen-A-redemption', A, ISSUER, ['tecNO_PERMISSION', ...lockErrors]);
  await step('unfreeze-A', () => issuer.setHolderFreeze(A.classicAddress, false, 'unfreeze-A'));
  await step('A-to-B', () => send('A-to-B', payment(A, B.classicAddress), A));
  await step('B-to-A', () => send('B-to-A', payment(B, A.classicAddress), B));
  await step('global-freeze', () => issuer.setGlobalFreeze(true, 'global-freeze'));
  await blocked('global-transfer', A, B.classicAddress, lockErrors);
  await step('guard-global-issuance', () => assert.rejects(issuer.issue(A.classicAddress, '1', 'guard-global-issuance'), /freeze policy/));
  await blocked('global-redemption', A, ISSUER, ['tecNO_PERMISSION', ...lockErrors]);
  await step('global-unfreeze', () => issuer.setGlobalFreeze(false, 'global-unfreeze'));
  await step('after-global-A-to-B', () => send('after-global-A-to-B', payment(A, B.classicAddress), A));
  await step('after-global-B-to-A', () => send('after-global-B-to-A', payment(B, A.classicAddress), B));
  await step('freeze-B', () => issuer.setHolderFreeze(B.classicAddress, true, 'freeze-B'));
  await step('ban-C', () => issuer.ban(C.classicAddress, 'demo-compliance-ban', 'ban-C'));
  await blocked('banned-C-receive', A, C.classicAddress, ['tecNO_AUTH', ...lockErrors]);
  await step('ban-policy', async () => {
    await assert.rejects(issuer.approve(C.classicAddress, 'forbidden-reapprove'), /banned/);
    await assert.rejects(issuer.setHolderFreeze(C.classicAddress, false, 'forbidden-unfreeze'), /banned/);
  });
  // Current testnet permits deletion of a locked, empty holding. Recreating it must not restore approval.
  await step('C-delete', async () => {
    try { await send('C-delete', { ...issuer.optInTransaction(C.classicAddress), Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize }, C); }
    catch (e) { if (!(e instanceof LedgerFailure && e.code === 'tecNO_PERMISSION')) throw e; }
  });
  await step('C-recreate', async () => {
    if (!(await issuer.holder(C.classicAddress))) await send('C-recreate', issuer.optInTransaction(C.classicAddress), C);
  });
  await blocked('recreated-C-receive', A, C.classicAddress, ['tecNO_AUTH', ...lockErrors]);
  await blocked('recreated-C-issuance', wallet, C.classicAddress, ['tecNO_AUTH', ...lockErrors]);
  const evidence = await verify(issuer, result);
  await writeJson('verification.json', evidence);
  await writeJson('transactions.json', runtime.audit());
  await writeJson('result.json', result);
  console.log('Verified final state; wrote result.json and verification.json');
} finally { await runtime.close(); }
