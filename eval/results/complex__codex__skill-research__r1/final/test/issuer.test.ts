import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Wallet, decode, encode, type SubmittableTransaction, type TransactionMetadata } from 'xrpl';
import { MptIssuer, amount, MAX_AMOUNT, CAPABILITIES, holderAddress } from '../src/issuer.js';
import { TransactionRunner, TransactionFailure, UnresolvedTransaction } from '../src/transactions.js';

const wallet = Wallet.generate(), destination = Wallet.generate().classicAddress;
const intent: SubmittableTransaction = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: destination, Amount: '1' };
function fixture() {
  mkdirSync(join(process.cwd(), '.private'), { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(process.cwd(), '.private', 'test-'));
  let submits = 0, fills = 0;
  let fail = false, code = 'tesSUCCESS';
  const client = {
    request: async (request: { command: string }) => {
      if (request.command === 'server_info') return { result: { info: { network_id: 1 } } };
      throw { data: { error: 'txnNotFound' } };
    },
    autofill: async (tx: SubmittableTransaction) => { fills++; return { ...tx, Fee: '12', Sequence: 1, LastLedgerSequence: 100 }; },
    submitAndWait: async () => {
      submits++;
      if (fail) throw new Error('Disconnected');
      return { result: { validated: true, ledger_index: 90, meta: { TransactionResult: code, AffectedNodes: [], TransactionIndex: 0 } as TransactionMetadata } };
    },
  } as unknown as Client;
  const path = join(directory, 'journal.json');
  let runner = new TransactionRunner(client, path);
  return { client, path, get runner() { return runner; }, counts: () => ({ submits, fills }),
    fail: (value: boolean) => { fail = value; }, code: (value: string) => { code = value; },
    restart: () => { runner.close(); runner = new TransactionRunner(client, path); },
    close: () => { runner.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
test('integer precision and invalid amounts', () => {
  for (const value of ['0', '-1', '1.1', '01', '1e3', '', ' 1', (2n ** 63n).toString()]) assert.throws(() => amount(value));
  assert.equal(amount(MAX_AMOUNT), MAX_AMOUNT); assert.equal(amount('9007199254740993'), '9007199254740993');
  assert.throws(() => holderAddress(wallet.classicAddress, wallet.classicAddress));
  assert.throws(() => holderAddress('invalid', wallet.classicAddress));
});
test('MPT transactions serialize with precise amounts and required holder field', () => {
  const id = '00000001' + 'AB'.repeat(20);
  const transactions: SubmittableTransaction[] = [
    { TransactionType: 'MPTokenIssuanceCreate', Account: wallet.classicAddress, Flags: CAPABILITIES, AssetScale: 0 },
    { TransactionType: 'MPTokenAuthorize', Account: wallet.classicAddress, MPTokenIssuanceID: id, Holder: destination, Flags: 1 },
    { TransactionType: 'MPTokenIssuanceSet', Account: wallet.classicAddress, MPTokenIssuanceID: id, Holder: destination, Flags: 1 },
    { TransactionType: 'Clawback', Account: wallet.classicAddress, Holder: destination, Amount: { mpt_issuance_id: id, value: MAX_AMOUNT } },
  ];
  for (const tx of transactions) assert.deepEqual(decode(encode(tx)), tx);
});
test('idempotency survives restart; changed intent cannot reuse key', async () => {
  const f = fixture();
  try {
    const first = await f.runner.send('operation', intent, wallet);
    f.restart();
    assert.deepEqual(await f.runner.send('operation', intent, wallet), first);
    assert.deepEqual(f.counts(), { submits: 1, fills: 1 });
    await assert.rejects(f.runner.send('operation', { ...intent, Amount: '2' }, wallet), /different transaction/);
  } finally { f.close(); }
});
test('uncertain outcomes block new operations and retry only the original signed transaction', async () => {
  const f = fixture();
  try {
    f.fail(true);
    await assert.rejects(f.runner.send('pending', intent, wallet), UnresolvedTransaction);
    f.restart();
    await assert.rejects(f.runner.send('another', intent, wallet), UnresolvedTransaction);
    f.fail(false);
    await f.runner.send('pending', intent, wallet);
    assert.deepEqual(f.counts(), { submits: 2, fills: 1 });
  } finally { f.close(); }
});
test('validated failure is durable and never retried as a new transaction', async () => {
  const f = fixture();
  try {
    f.code('tecNO_AUTH');
    await assert.rejects(f.runner.send('denied', intent, wallet), TransactionFailure);
    f.restart();
    await assert.rejects(f.runner.send('denied', intent, wallet), TransactionFailure);
    assert.deepEqual(f.counts(), { submits: 1, fills: 1 });
  } finally { f.close(); }
});
test('ban policy survives restart and writer lock prevents concurrent writers', () => {
  const f = fixture();
  try {
    assert.throws(() => new TransactionRunner(f.client, f.path), /EEXIST/);
    f.runner.markBanned('id', destination, 'compliance case'); f.restart();
    assert.equal(f.runner.isBanned('id', destination), true);
  } finally { f.close(); }
});
test('exclusive operations are serialized even after rejection', async () => {
  const f = fixture();
  try {
    const events: number[] = [];
    const first = f.runner.exclusive(async () => { events.push(1); await Promise.resolve(); events.push(2); throw new Error('stop'); });
    const second = f.runner.exclusive(async () => { events.push(3); });
    await assert.rejects(first); await second; assert.deepEqual(events, [1, 2, 3]);
  } finally { f.close(); }
});

test('fee ceiling and wrong network stop before signing/submission', async () => {
  const f = fixture();
  try {
    f.client.autofill = (async (tx: SubmittableTransaction) => ({ ...tx, Fee: '10001', Sequence: 1, LastLedgerSequence: 100 })) as Client['autofill'];
    await assert.rejects(f.runner.send('expensive', intent, wallet), /fee above/);
    f.client.request = (async () => ({ result: { info: { network_id: 0 } } })) as Client['request'];
    await assert.rejects(f.runner.send('wrong-network', intent, wallet), /Testnet/);
    assert.equal(f.counts().submits, 0);
  } finally { f.close(); }
});
test('unvalidated results never produce success receipts', async () => {
  const f = fixture();
  try {
    f.client.submitAndWait = (async () => ({ result: { validated: false, ledger_index: 90, meta: { TransactionResult: 'tesSUCCESS' } } })) as unknown as Client['submitAndWait'];
    await assert.rejects(f.runner.send('unvalidated', intent, wallet), UnresolvedTransaction);
    await assert.rejects(f.runner.send('new', intent, wallet), UnresolvedTransaction);
  } finally { f.close(); }
});

test('ban persists denial before ledger work and remains fail-closed after interruption', async () => {
  const f = fixture();
  const id = '00000001' + 'AB'.repeat(20);
  try {
    const token = new MptIssuer(f.runner, wallet, id);
    token.assertConfiguration = async () => undefined;
    token.holding = async () => ({ LedgerEntryType: 'MPToken', index: '', PreviousTxnID: '', PreviousTxnLgrSeq: 1, MPTokenIssuanceID: id, MPTAmount: '100', Flags: 2 });
    f.runner.send = async () => {
      assert.equal(f.runner.isBanned(id, destination), true);
      throw new Error('interrupted');
    };
    await assert.rejects(token.ban(destination, 'case-reference', 'ban'), /interrupted/);
    f.restart();
    const restarted = new MptIssuer(f.runner, wallet, id);
    await assert.rejects(restarted.approve(destination, 'approve'), /permanently banned/);
    await assert.rejects(restarted.issue(destination, '1', 'issue'), /permanently banned/);
    await assert.rejects(restarted.freezeHolder(destination, false, 'unlock'), /permanently banned/);
  } finally { f.close(); }
});
test('mint policy blocks both individual and global locks even though native issuer payments bypass them', async () => {
  const f = fixture();
  const id = '00000001' + 'AB'.repeat(20);
  try {
    const token = new MptIssuer(f.runner, wallet, id);
    token.assertConfiguration = async () => undefined;
    let global = false, individual = true;
    token.issuance = async () => ({ LedgerEntryType: 'MPTokenIssuance', index: '', PreviousTxnID: '', PreviousTxnLgrSeq: 1,
      Issuer: wallet.classicAddress, Sequence: 1, Flags: CAPABILITIES | Number(global), OutstandingAmount: '100', OwnerNode: '0' });
    token.holding = async () => ({ LedgerEntryType: 'MPToken', index: '', PreviousTxnID: '', PreviousTxnLgrSeq: 1,
      MPTokenIssuanceID: id, MPTAmount: '100', Flags: 2 | Number(individual) });
    await assert.rejects(token.issue(destination, '1', 'locked-individual'), /frozen/);
    global = true; individual = false;
    await assert.rejects(token.issue(destination, '1', 'locked-global'), /frozen/);
    assert.equal(f.counts().submits, 0);
  } finally { f.close(); }
});

test('ban resumes a pending drain even when the ledger already shows zero', async () => {
  const f = fixture();
  const id = '00000001' + 'AB'.repeat(20);
  try {
    const token = new MptIssuer(f.runner, wallet, id);
    token.assertConfiguration = async () => undefined;
    token.holding = async () => ({ LedgerEntryType: 'MPToken', index: '', PreviousTxnID: '', PreviousTxnLgrSeq: 1,
      MPTokenIssuanceID: id, MPTAmount: '0', Flags: 0 });
    f.runner.hasOperation = key => key === 'ban:drain';
    const reconciled: string[] = [];
    f.runner.send = async (key) => {
      reconciled.push(key);
      return { hash: 'ABC', ledger: 90, code: 'tesSUCCESS', meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [], TransactionIndex: 0 } };
    };
    await token.ban(destination, 'case-reference', 'ban');
    assert.deepEqual(reconciled, ['ban:revoke', 'ban:drain']);
  } finally { f.close(); }
});

test('ledger reader interprets omitted default MPTAmount as zero', async () => {
  const f = fixture();
  try {
    f.client.request = (async () => ({ result: { node: { LedgerEntryType: 'MPToken', Flags: 0 } } })) as Client['request'];
    const token = new MptIssuer(f.runner, wallet, '00000001' + 'AB'.repeat(20));
    assert.equal((await token.holding(destination))?.MPTAmount, '0');
  } finally { f.close(); }
});
