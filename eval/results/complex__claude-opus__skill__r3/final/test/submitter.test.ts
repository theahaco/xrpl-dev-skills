import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Wallet } from 'xrpl';
import {
  TransactionFailedError,
  TransactionNotAppliedError,
  TransactionOutcomeUnknownError,
  TransactionSubmitter,
} from '../src/index.js';
import { FakeLedger } from './fakeLedger.js';

const wallet = Wallet.generate();
const setup = (opts = {}) => {
  const ledger = new FakeLedger();
  ledger.issuer = wallet.classicAddress;
  const submitter = new TransactionSubmitter(ledger.asClient(), wallet, { pollIntervalMs: 0, timeoutMs: 200, ...opts });
  const tx = { TransactionType: 'AccountSet' as const, Account: wallet.classicAddress };
  return { ledger, submitter, tx };
};

test('resolves only for validated tesSUCCESS, and sets LastLedgerSequence', async () => {
  const { ledger, submitter, tx } = setup();
  const res = await submitter.submit(tx);
  assert.equal(res.resultCode, 'tesSUCCESS');
  assert.equal(ledger.submitted[0]?.LastLedgerSequence, 120);
});

test('tem/tef preliminary results are definitively not applied', async () => {
  for (const code of ['temMALFORMED', 'tefPAST_SEQ']) {
    const { ledger, submitter, tx } = setup();
    ledger.nextSubmitResult.push(code);
    await assert.rejects(submitter.submit(tx), (e) => e instanceof TransactionNotAppliedError && e.engineResult === code);
  }
});

test('validated tec result throws TransactionFailedError with hash and code', async () => {
  const { ledger, submitter, tx } = setup();
  ledger.nextFinalResult.push('tecNO_AUTH');
  await assert.rejects(submitter.submit(tx), (e) => e instanceof TransactionFailedError && e.resultCode === 'tecNO_AUTH' && e.hash.length === 64);
});

test('expired transaction (searched_all, past LastLedgerSequence) is not applied', async () => {
  const { ledger, submitter, tx } = setup({ timeoutMs: 5_000 });
  ledger.txBehaviour = 'never';
  await assert.rejects(submitter.submit(tx), TransactionNotAppliedError);
});

test('submit transport error still polls, and succeeds if the tx landed', async () => {
  const { ledger, tx } = setup();
  // Simulate: the transaction reached the network, but the submit response was lost.
  const client = ledger.asClient();
  const original = client.request.bind(client);
  (client as unknown as { request: unknown }).request = async (req: { command: string }) => {
    const r = await original(req as never);
    if (req.command === 'submit') throw new Error('socket hang up');
    return r;
  };
  const s = new TransactionSubmitter(client, wallet, { pollIntervalMs: 0, timeoutMs: 1_000 });
  assert.equal((await s.submit(tx)).resultCode, 'tesSUCCESS');
});

test('outcome unknown when the node never answers definitively', async () => {
  const { ledger, tx } = setup();
  const client = ledger.asClient();
  const original = client.request.bind(client);
  (client as unknown as { request: unknown }).request = async (req: { command: string }) => {
    if (req.command === 'tx') throw Object.assign(new Error('x'), { data: { error: 'txnNotFound', searched_all: false } });
    return original(req as never);
  };
  const s = new TransactionSubmitter(client, wallet, { pollIntervalMs: 0, timeoutMs: 50 });
  await assert.rejects(s.submit(tx), TransactionOutcomeUnknownError);
});

test('refuses to sign for a different account, or above the fee cap', async () => {
  const { submitter, tx } = setup({ maxFeeDrops: 10 });
  await assert.rejects(submitter.submit({ ...tx, Account: Wallet.generate().classicAddress }), /does not match signer/);
  await assert.rejects(submitter.submit(tx), /exceeds cap/);
});

test('queue serializes: prechecks run after earlier transactions are final', async () => {
  const { ledger, submitter, tx } = setup();
  const seen: number[] = [];
  const p1 = submitter.submit(tx);
  const p2 = submitter.submit(tx, async () => {
    seen.push(ledger.submitted.length);
  });
  await Promise.all([p1, p2]);
  assert.deepEqual(seen, [1]);
  assert.equal(await submitter.submit(tx, async () => 'skip'), null);
});
