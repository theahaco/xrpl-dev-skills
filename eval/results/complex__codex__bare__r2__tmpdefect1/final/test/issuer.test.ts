import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Wallet, type Client, type SubmittableTransaction } from 'xrpl';
import { amount, MAX_AMOUNT, holderAddress, TransactionRunner, MptIssuer, CAPABILITIES, SubmissionUnknown } from '../src/issuer.js';
import { SqliteStore } from '../src/storage.js';

test('amounts preserve precision and reject malformed, fractional and oversized input', () => {
  assert.equal(amount(MAX_AMOUNT.toString()), MAX_AMOUNT.toString());
  for (const value of ['0', '-1', '1.0', '1e3', '01', ' 1', '', (MAX_AMOUNT + 1n).toString()]) assert.throws(() => amount(value));
  const issuer = Wallet.generate().classicAddress;
  assert.throws(() => holderAddress(issuer, issuer));
  assert.throws(() => holderAddress('invalid', issuer));
});

test('ban persists across reopen; unknown transactions block restart', async () => {
  const dir = mkdtempSync('.test-');
  try {
    let store = new SqliteStore(`${dir}/store.sqlite`);
    await store.add('token', 'holder'); store.close();
    store = new SqliteStore(`${dir}/store.sqlite`);
    assert.equal(await store.has('token', 'holder'), true);
    await store.prepared({ hash: 'pending', blob: 'blob', lastLedgerSequence: 10, transaction: { TransactionType: 'MPTokenAuthorize', Account: 'account', MPTokenIssuanceID: 'id' } });
    assert.throws(() => store.assertNoPending(), /pending/); store.close();
  } finally { rmSync(dir, { recursive: true }); }
});

test('ambiguous submission halts runner instead of retrying a financial operation', async () => {
  const wallet = Wallet.generate(); let calls = 0; let persisted = false;
  const client = {
    request: async () => ({ result: { info: { network_id: 1 } } }),
    autofill: async (tx: SubmittableTransaction) => ({ ...tx, Sequence: 1, Fee: '10', LastLedgerSequence: 100 }),
    submitAndWait: async () => { calls++; assert(persisted); throw new Error('connection lost'); },
  } as unknown as Client;
  const runner = new TransactionRunner(client, { prepared: async () => { persisted = true; }, validated: async () => {} });
  const tx: SubmittableTransaction = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: Wallet.generate().classicAddress, Amount: '1' };
  await assert.rejects(runner.submit(wallet, tx), SubmissionUnknown);
  await assert.rejects(runner.submit(wallet, tx), /halted/);
  assert.equal(calls, 1);
});

test('ban revokes before clawback and resumes safely after clawback failure', async () => {
  const wallet = Wallet.generate(), holder = Wallet.generate().classicAddress;
  let flags = 2, balance = '200', banned = false, fail = true;
  const events: string[] = [];
  const runner = {
    client: { request: async (request: { mpt_issuance?: string }) => ({ result: { node: request.mpt_issuance
      ? { LedgerEntryType: 'MPTokenIssuance', Issuer: wallet.classicAddress, Flags: CAPABILITIES }
      : { LedgerEntryType: 'MPToken', Flags: flags, MPTAmount: balance } } }) },
    submit: async (_wallet: Wallet, tx: SubmittableTransaction) => {
      events.push(tx.TransactionType);
      if (tx.TransactionType === 'MPTokenAuthorize') flags &= ~2;
      if (tx.TransactionType === 'MPTokenIssuanceSet') flags |= 1;
      if (tx.TransactionType === 'Clawback') { assert.equal(flags, 1); if (fail) throw new Error('failure'); balance = '0'; }
    },
  } as unknown as TransactionRunner;
  const token = new MptIssuer(runner, wallet, '0'.repeat(48), { has: async () => banned, add: async () => { banned = true; events.push('persist'); } });
  await assert.rejects(token.ban(holder), /failure/);
  assert(banned); assert.equal(flags, 1); assert.equal(balance, '200');
  await assert.rejects(token.approve(holder), /banned/);
  fail = false; await token.ban(holder);
  assert.equal(balance, '0'); assert.equal(flags, 1);
  assert.deepEqual(events.slice(0, 4), ['persist', 'MPTokenAuthorize', 'MPTokenIssuanceSet', 'Clawback']);
});
