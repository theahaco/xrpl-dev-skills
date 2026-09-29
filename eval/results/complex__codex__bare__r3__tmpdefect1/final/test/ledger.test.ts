import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, Wallet, type SubmittableTransaction } from 'xrpl';
import { LedgerExecutor, OutcomeUnknown, requireSuccess, TransactionFailed } from '../src/ledger.js';
import type { Store } from '../src/store.js';

class MemoryStore implements Store {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
}
function setup() {
  const store = new MemoryStore();
  const wallet = Wallet.generate();
  const tx: SubmittableTransaction = { TransactionType: 'Payment', Account: wallet.address,
    Destination: Wallet.generate().address, Amount: '1000000' };
  let submitCount = 0;
  let autofillCount = 0;
  let failSubmit = false;
  let validated = false;
  let code = 'tesSUCCESS';
  let network = 1;
  const response = () => ({ result: { validated: true, ledger_index: 2,
    meta: { TransactionResult: code, TransactionIndex: 0, AffectedNodes: [] } } });
  const fake = {
    request: async (request: { command: string }) => {
      if (request.command === 'server_info') return { result: { info: { network_id: network, validated_ledger: { age: 1 } } } };
      if (validated) return response();
      throw { data: { error: 'txnNotFound' } };
    },
    autofill: async (input: SubmittableTransaction) => { autofillCount++; return { ...input, Sequence: 1, Fee: '12', LastLedgerSequence: 20 }; },
    submitAndWait: async () => {
      submitCount++;
      assert.ok(await store.get('tx:pay'), 'journal exists before submission');
      assert.equal(await store.get('pendingTransaction'), 'pay');
      validated = true;
      if (failSubmit) throw new Error('connection lost after acceptance');
      return response();
    },
  };
  const executor = new LedgerExecutor(fake as unknown as Client, store);
  return { store, wallet, tx, executor, fake,
    counts: () => ({ submitCount, autofillCount }),
    disconnect: () => { failSubmit = true; }, fail: () => { code = 'tecNO_AUTH'; },
    mainnet: () => { network = 0; } };
}

test('concurrent duplicate operation is submitted once and conflicting reuse is refused', async () => {
  const f = setup();
  const [a, b] = await Promise.all([f.executor.execute('pay', f.tx, f.wallet), f.executor.execute('pay', f.tx, f.wallet)]);
  assert.deepEqual(a, b);
  assert.deepEqual(f.counts(), { submitCount: 1, autofillCount: 1 });
  await assert.rejects(f.executor.execute('pay', { ...f.tx, Amount: '2000000' } as SubmittableTransaction, f.wallet), /different payload/);
});

test('ambiguous submission blocks new mutations and reconciles by hash after restart without resigning', async () => {
  const f = setup(); f.disconnect();
  await assert.rejects(f.executor.execute('pay', f.tx, f.wallet), OutcomeUnknown);
  await assert.rejects(f.executor.execute('other', f.tx, f.wallet), /pending operation pay/);
  const restarted = new LedgerExecutor(f.fake as unknown as Client, f.store);
  assert.equal((await restarted.reconcilePending())?.code, 'tesSUCCESS');
  assert.equal(await f.store.get('pendingTransaction'), '');
  assert.deepEqual(f.counts(), { submitCount: 1, autofillCount: 1 });
});

test('validated tec result is a failure, retained as evidence, and never resubmitted', async () => {
  const f = setup(); f.fail();
  const receipt = await f.executor.execute('pay', f.tx, f.wallet);
  assert.throws(() => requireSuccess(receipt), TransactionFailed);
  assert.equal((await f.executor.execute('pay', f.tx, f.wallet)).code, 'tecNO_AUTH');
  assert.equal(f.counts().submitCount, 1);
});

test('mainnet and changed signer payload are rejected before broadcasting', async () => {
  const f = setup(); f.mainnet();
  await assert.rejects(f.executor.execute('pay', f.tx, f.wallet), /non-testnet/);
  assert.equal(f.counts().submitCount, 0);
  const g = setup();
  await assert.rejects(g.executor.execute('pay', g.tx, { address: g.wallet.address,
    sign: prepared => g.wallet.sign({ ...prepared, Amount: '2000000' } as SubmittableTransaction),
  }), /modified transaction/);
  assert.equal(g.counts().submitCount, 0);
});

test('durability failure before submit prevents broadcast', async () => {
  const f = setup();
  f.store.set = async () => { throw new Error('disk full'); };
  await assert.rejects(f.executor.execute('pay', f.tx, f.wallet), /disk full/);
  assert.equal(f.counts().submitCount, 0);
});
