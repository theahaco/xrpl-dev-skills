import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, Wallet } from 'xrpl';
import { LedgerFailure, TransactionRunner, UnresolvedTransaction, type Store } from '../src/index.js';

function fixture() {
  const wallet = Wallet.generate();
  const data = new Map<string, unknown>();
  const store: Store = {
    async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    async put(key, value) { data.set(key, structuredClone(value)); },
  };
  let submits = 0; let fills = 0; let fail = false; let code = 'tesSUCCESS'; let validated = true; let fee = '12';
  const client = {
    async request(request: { command: string }) {
      if (request.command === 'server_info') return { result: { info: { network_id: 1 } } };
      throw { data: { error: 'txnNotFound' } };
    },
    async autofill(tx: object) { fills++; return { ...tx, Fee: fee, Sequence: 1, LastLedgerSequence: 100 }; },
    async submitAndWait() {
      submits++;
      if (fail) throw new Error('timeout');
      return { result: { hash: 'HASH', validated, ledger_index: 99, meta: { TransactionResult: code } } };
    },
  } as unknown as Client;
  const signer = { address: wallet.classicAddress, sign: () => ({ hash: 'HASH', tx_blob: 'BLOB' }) };
  const runner = () => new TransactionRunner(client, signer, store);
  const tx = { TransactionType: 'MPTokenAuthorize' as const, Account: wallet.classicAddress, MPTokenIssuanceID: 'A'.repeat(48) };
  return { runner, tx, counts: () => ({ submits, fills }), fail: (v: boolean) => { fail = v; }, code: (v: string) => { code = v; }, validated: (v: boolean) => { validated = v; }, fee: (v: string) => { fee = v; } };
}
test('replayed operation returns receipt without submitting twice; conflicting key fails', async () => {
  const f = fixture();
  await f.runner().execute('one', f.tx);
  await f.runner().execute('one', f.tx);
  assert.deepEqual(f.counts(), { fills: 1, submits: 1 });
  await assert.rejects(f.runner().execute('one', { ...f.tx, Flags: 1 }), /different transaction/);
});
test('unknown result blocks new operation and resumes identical signed bytes after restart', async () => {
  const f = fixture(); f.fail(true);
  await assert.rejects(f.runner().execute('one', f.tx), UnresolvedTransaction);
  await assert.rejects(f.runner().execute('two', f.tx), /Reconcile pending/);
  f.fail(false);
  await f.runner().execute('one', f.tx);
  assert.deepEqual(f.counts(), { fills: 1, submits: 2 });
});
test('validated tec failure is distinct and permanently cached', async () => {
  const f = fixture(); f.code('tecNO_AUTH');
  await assert.rejects(f.runner().execute('one', f.tx), LedgerFailure);
  await assert.rejects(f.runner().execute('one', f.tx), LedgerFailure);
  assert.equal(f.counts().submits, 1);
});
test('unvalidated success is never accepted', async () => {
  const f = fixture(); f.validated(false);
  await assert.rejects(f.runner().execute('one', f.tx), UnresolvedTransaction);
});
test('fee cap stops signing/submission', async () => {
  const f = fixture(); f.fee('10001');
  await assert.rejects(f.runner().execute('one', f.tx), /Fee cap/);
  assert.equal(f.counts().submits, 0);
});
