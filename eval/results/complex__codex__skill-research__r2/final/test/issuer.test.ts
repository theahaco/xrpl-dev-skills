import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client, Wallet, type SubmittableTransaction } from 'xrpl';
import { amount, CAPABILITIES, Issuer, MAX_AMOUNT, optIn } from '../src/issuer.js';
import { Ledger, LedgerFailure, PendingTransaction, ExpiredTransaction, type Signer } from '../src/ledger.js';
import { Store } from '../src/store.js';

const issuer = Wallet.generate(), holder = Wallet.generate();
const issuanceId = '0'.repeat(48);
test('amount validation preserves exact integers and rejects malformed/unsafe amounts', () => {
  for (const v of ['0', '-1', '1.1', '1e3', '01', ' 1', '9223372036854775808']) assert.throws(() => amount(v));
  assert.equal(amount(MAX_AMOUNT), MAX_AMOUNT);
  assert.equal(amount('9007199254740993'), '9007199254740993');
});
test('holder opt-in has no issuer approval fields', () => {
  assert.deepEqual(optIn(holder.classicAddress, issuanceId), { TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress, MPTokenIssuanceID: issuanceId });
  assert.throws(() => optIn('invalid', issuanceId));
});
function fixture() {
  const path = mkdtempSync('.test-');
  const store = new Store(`${path}/state.sqlite`);
  const client = new Client('wss://example.invalid');
  const amendments = ['MPTokensV1', 'Clawback', 'fixMPTDeliveredAmount'].map(n => createHash('sha512').update(n).digest('hex').slice(0, 64).toUpperCase());
  let submissions = 0, signs = 0, fail = false;
  const meta = { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [] };
  const response = { result: { validated: true, ledger_index: 10, meta } };
  client.request = (async (r: { command: string }) => {
    if (r.command === 'server_info') return { result: { info: { network_id: 1, validated_ledger: { age: 1 } } } };
    if (r.command === 'tx') throw new Error('txnNotFound');
    return { result: { validated: true, node: { LedgerEntryType: 'Amendments', Amendments: amendments } } };
  }) as typeof client.request;
  client.getLedgerIndex = async () => 1;
  client.autofill = (async (tx: SubmittableTransaction) => ({ ...tx, Fee: '12', Sequence: 1, LastLedgerSequence: 20 })) as typeof client.autofill;
  client.submitAndWait = (async () => { submissions++; if (fail) throw new Error('Disconnected'); return response; }) as unknown as typeof client.submitAndWait;
  const signer: Signer = { classicAddress: issuer.classicAddress, sign: tx => { signs++; return issuer.sign(tx); } };
  const ledger = new Ledger(client, store);
  return { path, store, ledger, signer, response, counts: () => ({ submissions, signs }), fail: (v: boolean) => { fail = v; }, close: () => { store.close(); rmSync(path, { recursive: true }); } };
}
test('durable operation ID prevents duplicate submission and rejects changed input', async () => {
  const f = fixture();
  try {
    const tx = optIn(issuer.classicAddress, issuanceId);
    await f.ledger.send('one', tx, f.signer);
    await f.ledger.send('one', tx, f.signer);
    assert.deepEqual(f.counts(), { submissions: 1, signs: 1 });
    await assert.rejects(f.ledger.send('one', { ...tx, Flags: 1 }, f.signer), /different input/);
    assert.throws(() => new Store(`${f.path}/state.sqlite`), /EEXIST/);
  } finally { f.close(); }
});
test('unknown outcome blocks other operations and retries identical signed bytes without resigning', async () => {
  const f = fixture();
  try {
    const tx = optIn(issuer.classicAddress, issuanceId);
    f.fail(true);
    await assert.rejects(f.ledger.send('one', tx, f.signer), PendingTransaction);
    await assert.rejects(f.ledger.send('two', tx, f.signer), /Reconcile/);
    f.fail(false);
    await f.ledger.send('one', tx, f.signer);
    assert.deepEqual(f.counts(), { signs: 1, submissions: 2 });
  } finally { f.close(); }
});
test('validated tec failure is cached and never mistaken for success', async () => {
  const f = fixture();
  try {
    f.response.result.meta.TransactionResult = 'tecNO_AUTH';
    const tx = optIn(issuer.classicAddress, issuanceId);
    await assert.rejects(f.ledger.send('one', tx, f.signer), LedgerFailure);
    await assert.rejects(f.ledger.send('one', tx, f.signer), LedgerFailure);
    assert.equal(f.counts().submissions, 1);
  } finally { f.close(); }
});
test('ban persists before ledger operations, revokes before draining, survives retry and blocks reapproval', async () => {
  const f = fixture();
  try {
    const token = new Issuer(f.ledger, f.signer, issuanceId);
    token.issuance = async () => ({ index: '0'.repeat(64), LedgerEntryType: 'MPTokenIssuance', Issuer: issuer.classicAddress, Flags: CAPABILITIES, Sequence: 1, OutstandingAmount: '50', OwnerNode: '0', PreviousTxnID: '0'.repeat(64), PreviousTxnLgrSeq: 1 });
    let balance = '50', flags = 2, interrupted = true;
    token.holding = async () => ({ index: '0'.repeat(64), LedgerEntryType: 'MPToken', MPTokenIssuanceID: issuanceId, MPTAmount: balance, Flags: flags, PreviousTxnID: '0'.repeat(64), PreviousTxnLgrSeq: 1 });
    const calls: string[] = [];
    f.ledger.send = async (_id, tx) => {
      assert.ok(token.isBanned(holder.classicAddress));
      calls.push(tx.TransactionType);
      if (tx.TransactionType === 'MPTokenAuthorize') flags = 0;
      if (tx.TransactionType === 'Clawback') {
        if (interrupted) { interrupted = false; throw new Error('interrupted'); }
        balance = '0';
      }
      return { hash: '', ledger: 1, code: 'tesSUCCESS', meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [] } };
    };
    await assert.rejects(token.ban(holder.classicAddress, 'ban'), /interrupted/);
    await assert.rejects(token.approve(holder.classicAddress, 'approve'), /banned/);
    await token.ban(holder.classicAddress, 'ban');
    assert.deepEqual(calls, ['MPTokenAuthorize', 'Clawback', 'MPTokenAuthorize', 'Clawback']);
    assert.equal(balance, '0'); assert.equal(flags, 0);
  } finally { f.close(); }
});
test('full-history absence after expiry releases the gate, and the expired ID cannot be reused', async () => {
  const f = fixture();
  try {
    f.fail(true);
    let reads = 0;
    f.ledger.client.getLedgerIndex = async () => ++reads === 1 ? 1 : 30;
    const original = f.ledger.client.request.bind(f.ledger.client);
    f.ledger.client.request = (async (request: { command: string }) => {
      if (request.command === 'tx') throw Object.assign(new Error('txnNotFound'), { data: { error: 'txnNotFound', searched_all: true } });
      return original(request as Parameters<typeof original>[0]);
    }) as typeof f.ledger.client.request;
    const tx = optIn(issuer.classicAddress, issuanceId);
    await assert.rejects(f.ledger.send('expired', tx, f.signer), ExpiredTransaction);
    assert.equal(f.store.get('active'), null);
    await assert.rejects(f.ledger.send('expired', tx, f.signer), ExpiredTransaction);
    assert.equal(f.counts().signs, 1);
  } finally { f.close(); }
});
test('issuance guard refuses native issuer lock bypass for either global or holder lock', async () => {
  const f = fixture();
  try {
    const token = new Issuer(f.ledger, f.signer, issuanceId);
    let global = false;
    token.issuance = async () => ({ index: '0'.repeat(64), LedgerEntryType: 'MPTokenIssuance', Issuer: issuer.classicAddress, Flags: CAPABILITIES | (global ? 1 : 0), Sequence: 1, OutstandingAmount: '50', OwnerNode: '0', PreviousTxnID: '0'.repeat(64), PreviousTxnLgrSeq: 1 });
    token.holding = async () => ({ index: '0'.repeat(64), LedgerEntryType: 'MPToken', MPTokenIssuanceID: issuanceId, MPTAmount: '50', Flags: global ? 2 : 3, PreviousTxnID: '0'.repeat(64), PreviousTxnLgrSeq: 1 });
    await assert.rejects(token.issue(holder.classicAddress, '1', 'local'), /locked/);
    global = true;
    await assert.rejects(token.issue(holder.classicAddress, '1', 'global'), /locked/);
    assert.equal(f.counts().signs, 0);
  } finally { f.close(); }
});
test('store atomically rolls back and persists ban policy across restart', () => {
  const path = mkdtempSync('.test-');
  let store = new Store(`${path}/state.sqlite`);
  try {
    assert.throws(() => store.atomic(() => { store.put('partial', true); throw new Error('crash'); }));
    assert.equal(store.get('partial'), undefined);
    store.put(`ban:${issuanceId}:${holder.classicAddress}`, true);
    store.close();
    store = new Store(`${path}/state.sqlite`);
    assert.equal(store.get(`ban:${issuanceId}:${holder.classicAddress}`), true);
  } finally { store.close(); rmSync(path, { recursive: true }); }
});
test('holder reads normalize an omitted zero MPTAmount and reject malformed balances', async () => {
  const f = fixture();
  try {
    const token = new Issuer(f.ledger, f.signer, issuanceId);
    const node: Record<string, unknown> = { LedgerEntryType: 'MPToken', MPTokenIssuanceID: issuanceId, Flags: 0 };
    f.ledger.client.request = (async () => ({ result: { validated: true, node } })) as unknown as typeof f.ledger.client.request;
    assert.equal((await token.holding(holder.classicAddress))?.MPTAmount, '0');
    node.MPTAmount = '-1';
    await assert.rejects(token.holding(holder.classicAddress), /Invalid ledger MPT balance/);
  } finally { f.close(); }
});
