import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Wallet, decode, type SubmittableTransaction } from 'xrpl';
import { amount, CAPABILITIES, MAX_AMOUNT, MptIssuer, TransactionExecutor, walletSigner,
  LedgerFailure, UncertainSubmission, type ComplianceStore, type Operation } from '../src/issuer.js';
import { FileStore } from '../src/store.js';
const wallet = Wallet.generate();
const holder = Wallet.generate().classicAddress;
const id = '00000001' + 'AB'.repeat(20);
class MemoryStore implements ComplianceStore {
  ops = new Map<string, Operation>(); bans = new Set<string>();
  async getOperation(k: string) { return this.ops.get(k); }
  async putOperation(k: string, v: Operation) { this.ops.set(k, v); }
  async pendingOperation() { return [...this.ops].find(([, v]) => !v.receipt)?.[0]; }
  async isBanned(i: string, h: string) { return this.bans.has(i + h); }
  async markBanned(i: string, h: string) { this.bans.add(i + h); }
}
const payment: SubmittableTransaction = { TransactionType: 'Payment', Account: wallet.classicAddress,
  Destination: holder, Amount: { mpt_issuance_id: id, value: '10' } };
function fixture(code = 'tesSUCCESS', uncertain = false) {
  const store = new MemoryStore(); let submitted = 0;
  const client = {
    request: async (req: { command: string }) => {
      if (req.command === 'server_info') return { result: { info: { network_id: 1 } } };
      throw new Error('tx not found');
    },
    autofill: async (tx: SubmittableTransaction) => ({ ...tx, Fee: '10', Sequence: 1, LastLedgerSequence: 100 }),
    submitAndWait: async () => {
      assert(await store.pendingOperation(), 'Must persist before submission'); submitted++;
      if (uncertain) throw new Error('network dropped');
      return { result: { validated: true, ledger_index: 90, meta: { TransactionResult: code, AffectedNodes: [] } } };
    },
  };
  const executor = new TransactionExecutor(client as unknown as Client, store);
  return { executor, store, client, submitted: () => submitted };
}
test('amounts reject decimals, unsafe numeric formats, negatives, overflow and zero', () => {
  for (const value of ['0', '-1', '1.2', '01', '1e3', ' 1', (2n ** 63n).toString()]) assert.throws(() => amount(value));
  assert.equal(amount(MAX_AMOUNT), MAX_AMOUNT); assert.equal(amount('9007199254740993'), '9007199254740993');
});
test('locally signed MPT clawback encodes Holder and MPT amount correctly', () => {
  const signed = wallet.sign({ TransactionType: 'Clawback', Account: wallet.classicAddress,
    Holder: holder, Amount: { mpt_issuance_id: id, value: '300' }, Fee: '10', Sequence: 1, LastLedgerSequence: 100 });
  const tx = decode(signed.tx_blob);
  assert.equal(tx.Holder, holder); assert.deepEqual(tx.Amount, { mpt_issuance_id: id, value: '300' });
});
test('operation IDs prevent duplicate payments and conflicting reuse', async () => {
  const f = fixture(); const signer = walletSigner(wallet);
  const [a, b] = await Promise.all([f.executor.execute('one', payment, signer), f.executor.execute('one', payment, signer)]);
  assert.equal(a.hash, b.hash); assert.equal(f.submitted(), 1);
  await assert.rejects(f.executor.execute('one', { ...payment, Destination: wallet.classicAddress }, signer), /different transaction/);
});
test('validated tec is a durable failure, not success or retried payment', async () => {
  const f = fixture('tecNO_AUTH');
  await assert.rejects(f.executor.execute('one', payment, walletSigner(wallet)), LedgerFailure);
  await assert.rejects(f.executor.execute('one', payment, walletSigner(wallet)), LedgerFailure);
  assert.equal(f.submitted(), 1);
});
test('uncertain submission blocks subsequent operations; retry reuses signed blob', async () => {
  const f = fixture('tesSUCCESS', true);
  await assert.rejects(f.executor.execute('one', payment, walletSigner(wallet)), UncertainSubmission);
  const original = f.store.ops.get('one')?.blob;
  await assert.rejects(f.executor.execute('two', payment, walletSigner(wallet)), /Resolve pending/);
  await assert.rejects(f.executor.execute('one', payment, walletSigner(wallet)), UncertainSubmission);
  assert.equal(f.store.ops.get('one')?.blob, original); assert.equal(f.submitted(), 2);
});
test('fee cap prevents signing and submission', async () => {
  const f = fixture();
  f.client.autofill = async tx => ({ ...tx, Fee: '1001', Sequence: 1, LastLedgerSequence: 100 });
  await assert.rejects(f.executor.execute('fee', payment, walletSigner(wallet)), /fee exceeds/);
  assert.equal(f.submitted(), 0);
});
test('durable bans survive restart and block approval, mint and unfreeze', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mpt-'));
  try {
    await (await FileStore.load(join(dir, 'state.json'))).markBanned(id, holder);
    const store = await FileStore.load(join(dir, 'state.json'));
    const f = fixture();
    const issuer = new MptIssuer(new TransactionExecutor(f.client as unknown as Client, store), walletSigner(wallet), id);
    await assert.rejects(issuer.approve(holder, 'approve'), /permanently banned/);
    await assert.rejects(issuer.mint(holder, '1', 'mint'), /permanently banned/);
    await assert.rejects(issuer.setFrozen(holder, false, 'unlock'), /permanently banned/);
    assert.equal(f.submitted(), 0);
  } finally { await rm(dir, { recursive: true }); }
});
test('ban records policy, locks, revokes, sweeps, verifies; restart after partial failure is safe', async () => {
  const store = new MemoryStore(); let balance = '200'; let flags = 2; let fail = true;
  const calls: string[] = [];
  const executor = {
    store,
    client: { request: async (req: { mpt_issuance?: string }) => ({ result: { node: req.mpt_issuance ?
      { LedgerEntryType: 'MPTokenIssuance', Issuer: wallet.classicAddress, Flags: CAPABILITIES, AssetScale: 0 } :
      { LedgerEntryType: 'MPToken', MPTAmount: balance, Flags: flags } } }) },
    execute: async (key: string, tx: SubmittableTransaction) => {
      assert(await store.isBanned(id, holder));
      if (store.ops.has(key)) return;
      calls.push(tx.TransactionType);
      if (tx.TransactionType === 'MPTokenIssuanceSet') flags |= 1;
      if (tx.TransactionType === 'MPTokenAuthorize') { if (fail) { fail = false; throw new Error('offline'); } flags &= ~2; }
      if (tx.TransactionType === 'Clawback') { assert.equal(flags, 1); balance = '0'; }
      store.ops.set(key, { receipt: { code: 'tesSUCCESS' } } as Operation);
    },
  };
  const issuer = new MptIssuer(executor as unknown as TransactionExecutor, walletSigner(wallet), id);
  await assert.rejects(issuer.ban(holder, 'ban'), /offline/);
  await issuer.ban(holder, 'ban');
  assert.equal(balance, '0'); assert.equal(flags, 1);
  assert.deepEqual(calls, ['MPTokenIssuanceSet', 'MPTokenAuthorize', 'MPTokenAuthorize', 'Clawback']);
});
test('mint refuses global and individual locks before submitting', async () => {
  for (const global of [true, false]) {
    const f = fixture();
    const client = { ...f.client, request: async (req: { mpt_issuance?: string }) => ({ result: { node:
      req.mpt_issuance ? { LedgerEntryType: 'MPTokenIssuance', Issuer: wallet.classicAddress,
        Flags: CAPABILITIES | (global ? 1 : 0) } : { LedgerEntryType: 'MPToken', Flags: global ? 2 : 3, MPTAmount: '5' },
    } }) };
    const issuer = new MptIssuer(new TransactionExecutor(client as unknown as Client, f.store), walletSigner(wallet), id);
    await assert.rejects(issuer.mint(holder, '1', 'mint'), /freeze policy/);
    assert.equal(f.submitted(), 0);
  }
});
test('holder reads normalize omitted zero MPTAmount from rippled', async () => {
  const f = fixture();
  const client = { request: async () => ({ result: { node: { LedgerEntryType: 'MPToken', Flags: 1 } } }) };
  const issuer = new MptIssuer(new TransactionExecutor(client as unknown as Client, f.store), walletSigner(wallet), id);
  assert.equal((await issuer.holder(holder))?.MPTAmount, '0');
});
test('malformed durable policy is rejected, never silently reset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mpt-corrupt-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'state.json'), '{"operations":{},"bans":null}');
    await assert.rejects(FileStore.load(join(dir, 'state.json')), /Invalid compliance journal/);
  } finally { await rm(dir, { recursive: true }); }
});
