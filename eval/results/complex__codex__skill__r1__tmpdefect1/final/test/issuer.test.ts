import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, Wallet, decode, type SubmittableTransaction } from 'xrpl';
import { amount, MAX_AMOUNT, payment, CAPABILITIES, MptIssuer, Transactions, LedgerFailure,
  type Store, type Receipt } from '../src/index.js';

class MemoryStore implements Store {
  data = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.data.get(key) as T | undefined; }
  put<T>(key: string, value: T) { this.data.set(key, value); }
}
const wallet = Wallet.generate();
const holder = Wallet.generate();
const id = '00000001' + 'AB'.repeat(20);
test('amounts preserve integer precision and reject unsafe or malformed input', () => {
  assert.equal(amount(MAX_AMOUNT), MAX_AMOUNT);
  for (const input of ['0', '-1', '1.5', '01', '1e3', ' 1', '9223372036854775808']) {
    assert.throws(() => amount(input));
  }
});
test('payment is an MPT payment and survives actual signing/serialization', () => {
  const tx = payment(wallet.classicAddress, holder.classicAddress, id, MAX_AMOUNT);
  const decoded = decode(wallet.sign({ ...tx, Fee: '10', Sequence: 1, LastLedgerSequence: 100 }).tx_blob);
  assert.deepEqual(decoded.Amount, { mpt_issuance_id: id, value: MAX_AMOUNT });
  assert.throws(() => payment('bad', holder.classicAddress, id, '1'));
  assert.throws(() => payment(wallet.classicAddress, holder.classicAddress, 'bad', '1'));
});
function runnerFixture(code = 'tesSUCCESS', ambiguous = false) {
  const store = new MemoryStore();
  let submissions = 0;
  let fills = 0;
  const client = {
    autofill: async (tx: SubmittableTransaction) => {
      fills++; return { ...tx, Fee: '10', Sequence: 1, LastLedgerSequence: 100 };
    },
    request: async () => { throw { data: { error: 'txnNotFound' } }; },
    submitAndWait: async () => {
      submissions++;
      if (ambiguous) throw new Error('Connection lost');
      return { result: { validated: true, ledger_index: 50,
        meta: { TransactionResult: code, TransactionIndex: 0, AffectedNodes: [] } } };
    },
  } as unknown as Client;
  return { runner: new Transactions(client, store), store, counts: () => ({ submissions, fills }),
    resolve: () => { ambiguous = false; } };
}
test('durable idempotency avoids duplicate broadcasts and rejects key reuse', async () => {
  const f = runnerFixture();
  const tx = payment(wallet.classicAddress, holder.classicAddress, id, '1');
  await f.runner.submit('one', tx, wallet);
  await f.runner.submit('one', tx, wallet);
  assert.deepEqual(f.counts(), { submissions: 1, fills: 1 });
  await assert.rejects(f.runner.submit('one', { ...tx, Destination: wallet.classicAddress }, wallet), /reused/);
});
test('uncertain outcome blocks subsequent operations and retry reuses signed transaction', async () => {
  const f = runnerFixture('tesSUCCESS', true);
  const tx = payment(wallet.classicAddress, holder.classicAddress, id, '1');
  await assert.rejects(f.runner.submit('one', tx, wallet), /Connection lost/);
  await assert.rejects(f.runner.submit('two', tx, wallet), /Reconcile pending/);
  f.resolve();
  const restarted = new Transactions(f.runner.client, f.store);
  await restarted.resumePending(wallet);
  assert.deepEqual(f.counts(), { submissions: 2, fills: 1 });
});
test('validated tec is a failure, recorded without automatic retry', async () => {
  const f = runnerFixture('tecNO_AUTH');
  const tx = payment(wallet.classicAddress, holder.classicAddress, id, '1');
  await assert.rejects(f.runner.submit('one', tx, wallet), LedgerFailure);
  await assert.rejects(f.runner.submit('one', tx, wallet), LedgerFailure);
  assert.deepEqual(f.counts(), { submissions: 1, fills: 1 });
});
test('missing zero balance is normalized from rippled JSON', async () => {
  const client = { request: async (request: { mpt_issuance?: string }) => ({ result: { node:
    request.mpt_issuance ? { LedgerEntryType: 'MPTokenIssuance', Issuer: wallet.classicAddress,
      Flags: CAPABILITIES } : { LedgerEntryType: 'MPToken', MPTokenIssuanceID: id, Flags: 2 },
  } }) } as unknown as Client;
  const issuer = await MptIssuer.attach(new Transactions(client, new MemoryStore()), wallet, id);
  assert.equal((await issuer.holder(holder.classicAddress))?.MPTAmount, '0');
});
test('unvalidated response cannot be accepted as success', async () => {
  const f = runnerFixture();
  f.runner.client.submitAndWait = (async () => ({ result: { validated: false,
    ledger_index: 50, meta: { TransactionResult: 'tesSUCCESS' } } })) as unknown as Client['submitAndWait'];
  await assert.rejects(f.runner.submit('one', payment(wallet.classicAddress, holder.classicAddress, id, '1'), wallet),
    /Unresolved transaction/);
});
test('excessive fee is rejected before broadcasting', async () => {
  const f = runnerFixture();
  f.runner.client.autofill = (async (tx: SubmittableTransaction) => ({ ...tx, Fee: '1001',
    Sequence: 1, LastLedgerSequence: 100 })) as Client['autofill'];
  await assert.rejects(f.runner.submit('one', payment(wallet.classicAddress, holder.classicAddress, id, '1'), wallet),
    /fee exceeds/);
  assert.equal(f.counts().submissions, 0);
});
test('ban revokes before draining, survives failure, and prevents reapproval after restart', async () => {
  const store = new MemoryStore();
  let flags = 2;
  let balance = '250';
  let failDrain = true;
  const calls: string[] = [];
  const client = { request: async (request: { mpt_issuance?: string }) => ({ result: { node:
    request.mpt_issuance ? { LedgerEntryType: 'MPTokenIssuance', Issuer: wallet.classicAddress,
      Flags: CAPABILITIES } : { LedgerEntryType: 'MPToken', MPTokenIssuanceID: id, MPTAmount: balance, Flags: flags },
  } }) } as unknown as Client;
  class FakeTransactions extends Transactions {
    override async submit(_key: string, tx: SubmittableTransaction): Promise<Receipt> {
      calls.push(tx.TransactionType);
      if (tx.TransactionType === 'MPTokenAuthorize') flags &= ~2;
      if (tx.TransactionType === 'MPTokenIssuanceSet') flags |= 1;
      if (tx.TransactionType === 'Clawback') {
        assert.equal(flags & 2, 0);
        if (failDrain) throw new Error('Temporary outage');
        balance = '0';
      }
      return { hash: 'hash', ledger: 1, code: 'tesSUCCESS',
        meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [] } };
    }
  }
  const tx = new FakeTransactions(client, store);
  const issuer = await MptIssuer.attach(tx, wallet, id);
  await assert.rejects(issuer.ban(holder.classicAddress, 'ban'), /Temporary outage/);
  assert.deepEqual(calls, ['MPTokenAuthorize', 'MPTokenIssuanceSet', 'Clawback']);
  const restarted = await MptIssuer.attach(tx, wallet, id);
  await assert.rejects(restarted.approve(holder.classicAddress, 'approve'), /permanently banned/);
  await assert.rejects(restarted.mint(holder.classicAddress, '1', 'mint'), /permanently banned/);
  await assert.rejects(restarted.setHolderFrozen(holder.classicAddress, false, 'unlock'), /permanently banned/);
  failDrain = false;
  await restarted.ban(holder.classicAddress, 'ban');
  assert.equal(balance, '0');
  assert.equal(flags & 2, 0);
});
