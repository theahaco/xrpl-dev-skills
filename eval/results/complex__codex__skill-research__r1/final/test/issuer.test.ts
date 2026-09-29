import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Wallet, encode, decode, type Payment } from 'xrpl';
import { amount, MAX_AMOUNT, holderOptIn, MptIssuer } from '../src/issuer.js';
import { Store, Serial } from '../src/store.js';
import { Submitter, LedgerFailure, UnresolvedTransaction } from '../src/ledger.js';
const id = '00000001' + 'AB'.repeat(20);

test('integer amounts preserve precision and reject malformed or out-of-range input', () => {
  for (const bad of ['0', '-1', '1.2', '1e3', '01', ' 1', (MAX_AMOUNT + 1n).toString()]) assert.throws(() => amount(bad));
  assert.equal(amount(MAX_AMOUNT.toString()), '9223372036854775807');
  assert.equal(amount('9007199254740993'), '9007199254740993');
});
test('holder consent uses current SDK serialization without issuer authorization', () => {
  const holder = Wallet.generate();
  const tx = holderOptIn(holder.classicAddress, id);
  const roundtrip = decode(encode(tx));
  assert.equal(roundtrip.Account, holder.classicAddress);
  assert.equal(roundtrip.MPTokenIssuanceID, id);
  assert.equal(roundtrip.Holder, undefined);
  assert.throws(() => holderOptIn('invalid', id));
});
test('journal and bans survive restart; store rejects a second writer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpt-'));
  const path = join(dir, 'state.sqlite');
  const store = new Store(path);
  assert.throws(() => new Store(path));
  store.set('ban:x', { complete: false }); store.close();
  const reopened = new Store(path);
  assert.deepEqual(reopened.get('ban:x'), { complete: false });
  reopened.close(); rmSync(dir, { recursive: true });
});
test('serial executor isolates concurrent work and recovers after rejection', async () => {
  const serial = new Serial(); const order: number[] = [];
  const first = serial.run(async () => { await Promise.resolve(); order.push(1); throw new Error('expected'); });
  const second = serial.run(async () => { order.push(2); });
  await assert.rejects(first); await second; assert.deepEqual(order, [1, 2]);
});

test('submission retries identical signed bytes after ambiguity, never pays twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpt-')); const store = new Store(join(dir, 'state.sqlite'));
  let broadcasts = 0; let autofills = 0; let signed = 0;
  const wallet = Wallet.generate();
  const tx: Payment = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: Wallet.generate().classicAddress, Amount: '1' };
  const client = {
    async request(req: { command: string }) {
      if (req.command === 'server_info') return { result: { info: { network_id: 1 } } };
      if (req.command === 'ledger_entry') return { result: { validated: true, node: { LedgerEntryType: 'Amendments', Amendments: [
        '950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38',
        '56B241D7A43D40354D02A9DC4C8DF5C7A1F930D92A9035C4E12291B3CA3E1C2B',
      ] } } };
      throw { data: { error: 'txnNotFound' } };
    },
    async autofill(t: Payment) { autofills++; return { ...t, Fee: '12', LastLedgerSequence: 20, Sequence: 1 }; },
    async submitAndWait(blob: string) {
      broadcasts++; assert.equal(blob, 'SAME_BLOB');
      if (broadcasts === 1) throw new Error('connection lost after broadcast');
      return { result: { validated: true, ledger_index: 10, meta: { TransactionResult: 'tesSUCCESS' } } };
    },
  } as unknown as Client;
  const signer = { classicAddress: wallet.classicAddress, sign() { signed++; return { tx_blob: 'SAME_BLOB', hash: 'HASH' }; } };
  const submitter = new Submitter(client, store);
  try {
    await assert.rejects(submitter.submit('pay', tx, signer), UnresolvedTransaction);
    await assert.rejects(submitter.submit('another', tx, signer), /unresolved/);
    await submitter.submit('pay', tx, signer); await submitter.submit('pay', tx, signer);
    assert.equal(autofills, 1); assert.equal(signed, 1); assert.equal(broadcasts, 2);
    await assert.rejects(submitter.submit('pay', { ...tx, Amount: '2' }, signer), /Idempotency/);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
test('pending ban blocks approval and unlock even after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpt-')); const path = join(dir, 'state.sqlite');
  const holder = Wallet.generate().classicAddress; const issuerWallet = Wallet.generate();
  let store = new Store(path); store.set(`ban:${id}:${holder}`, { complete: false }); store.close();
  store = new Store(path);
  try {
    const issuer = new MptIssuer(new Submitter({} as Client, store), issuerWallet, id);
    await assert.rejects(issuer.approve(holder, 'approve'), /permanently banned/);
    await assert.rejects(issuer.setHolderFreeze(holder, false, 'unlock'), /permanently banned/);
    await assert.rejects(issuer.issue(holder, '1', 'issue'), /permanently banned/);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('ban persists denial before revocation and safely resumes a failed drain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpt-')); const store = new Store(join(dir, 'state.sqlite'));
  const signer = Wallet.generate(); const holder = Wallet.generate().classicAddress;
  const state = { LedgerEntryType: 'MPToken', Flags: 2, MPTAmount: '42' };
  const order: string[] = []; let failed = false;
  const submitter = {
    store, operations: new Serial(),
    client: { async request(req: { mpt_issuance?: string }) {
      return { result: { validated: true, node: req.mpt_issuance ? {
        LedgerEntryType: 'MPTokenIssuance', Issuer: signer.classicAddress, Flags: 102,
      } : { ...state } } };
    } },
    async submit(key: string, tx: { TransactionType: string }) {
      assert.ok(store.get(`ban:${id}:${holder}`), 'ban intent must commit before any submission');
      order.push(tx.TransactionType);
      if (tx.TransactionType === 'MPTokenAuthorize') state.Flags = 0;
      if (tx.TransactionType === 'Clawback') {
        if (!failed) { failed = true; throw new Error('network unavailable'); }
        state.MPTAmount = '0';
      }
      return { hash: key, ledger: 1, code: 'tesSUCCESS' };
    },
  } as unknown as Submitter;
  try {
    const issuer = new MptIssuer(submitter, signer, id);
    await assert.rejects(issuer.ban(holder, 'ban'), /network unavailable/);
    assert.equal(issuer.isBanned(holder), true);
    await assert.rejects(issuer.approve(holder, 'approve'), /permanently banned/);
    await issuer.ban(holder, 'retry');
    assert.deepEqual(order, ['MPTokenAuthorize', 'Clawback', 'MPTokenAuthorize', 'Clawback']);
    assert.equal(state.MPTAmount, '0'); assert.equal(state.Flags, 0);
    assert.deepEqual(store.get(`ban:${id}:${holder}`), { operationId: 'ban', complete: true });
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('issuance policy blocks both issuer exceptions before submitting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpt-')); const store = new Store(join(dir, 'state.sqlite'));
  const signer = Wallet.generate(); const holder = Wallet.generate().classicAddress;
  let globallyLocked = false;
  const submitter = {
    store, operations: new Serial(),
    client: { async request(req: { mpt_issuance?: string }) {
      return { result: { validated: true, node: req.mpt_issuance ? {
        LedgerEntryType: 'MPTokenIssuance', Issuer: signer.classicAddress, Flags: globallyLocked ? 103 : 102,
      } : { LedgerEntryType: 'MPToken', Flags: globallyLocked ? 2 : 3, MPTAmount: '1' } } };
    } },
    async submit() { assert.fail('Must not submit during freeze'); },
  } as unknown as Submitter;
  try {
    const issuer = new MptIssuer(submitter, signer, id);
    await assert.rejects(issuer.issue(holder, '1', 'individual'), /freeze policy/);
    globallyLocked = true;
    await assert.rejects(issuer.issue(holder, '1', 'global'), /freeze policy/);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('zero holder balance omitted by rippled is normalized safely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpt-')); const store = new Store(join(dir, 'state.sqlite'));
  const signer = Wallet.generate();
  const submitter = { store, operations: new Serial(), client: { async request() {
    return { result: { validated: true, node: { LedgerEntryType: 'MPToken', MPTokenIssuanceID: id, Flags: 0 } } };
  } } } as unknown as Submitter;
  try {
    const issuer = new MptIssuer(submitter, signer, id);
    assert.equal((await issuer.holder(Wallet.generate().classicAddress))?.MPTAmount, '0');
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
