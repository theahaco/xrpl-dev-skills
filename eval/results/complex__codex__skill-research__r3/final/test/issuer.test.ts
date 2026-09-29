import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Wallet, decode, decodeAccountID } from 'xrpl';
import { Journal, Runner, Serial, TransactionFailure } from '../src/runtime.js';
import { amount, MAX_AMOUNT, MptIssuer, CAPABILITIES } from '../src/issuer.js';

test('amount validation preserves precision and rejects ambiguous or invalid units', () => {
  assert.equal(amount(MAX_AMOUNT), MAX_AMOUNT);
  assert.equal(amount('9007199254740993'), '9007199254740993');
  for (const value of ['0', '-1', '1.1', '01', '1e3', '', ' 1', (BigInt(MAX_AMOUNT) + 1n).toString()]) assert.throws(() => amount(value));
});
test('serialization includes MPT Holder and excludes unsupported capabilities', () => {
  const wallet = Wallet.generate(), holder = Wallet.generate();
  const signed = wallet.sign({ TransactionType: 'Clawback', Account: wallet.address, Holder: holder.address,
    Amount: { mpt_issuance_id: '0'.repeat(48), value: '300' }, Fee: '10', Sequence: 1, LastLedgerSequence: 100 });
  const tx = decode(signed.tx_blob);
  assert.equal(tx.Holder, holder.address);
  assert.deepEqual(tx.Amount, { mpt_issuance_id: '0'.repeat(48), value: '300' });
  assert.equal(CAPABILITIES, 102);
});
test('serial queue remains ordered after failure', async () => {
  const queue = new Serial(), events: number[] = [];
  const first = queue.run(async () => { await Promise.resolve(); events.push(1); throw new Error('failure'); });
  const second = queue.run(async () => { events.push(2); });
  await assert.rejects(first); await second; assert.deepEqual(events, [1, 2]);
});
test('ban survives reopening the journal and forbids reapproval/unfreeze', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpt-test-')), path = join(dir, 'db');
  const wallet = Wallet.generate(), holder = Wallet.generate();
  const id = '00000000' + Buffer.from(decodeAccountID(wallet.address)).toString('hex').toUpperCase();
  let journal = new Journal(path);
  journal.ban(id, holder.address, 'KYC revoked'); journal.close();
  journal = new Journal(path);
  try {
    const issuer = new MptIssuer(new Runner(new Client('wss://example.com'), journal), wallet, id);
    await assert.rejects(issuer.approve(holder.address, 'approve'), /banned/);
    await assert.rejects(issuer.freeze(holder.address, false, 'unlock'), /banned/);
    await assert.rejects(issuer.issue(holder.address, '1', 'issue'), /banned/);
    assert.throws(() => new Journal(path), /EEXIST/);
  } finally { journal.close(); rmSync(dir, { recursive: true }); }
});
test('persisted receipts are idempotent and validated failures remain failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpt-test-'));
  const journal = new Journal(join(dir, 'db'));
  const signer = Wallet.generate(), dest = Wallet.generate();
  const tx = { TransactionType: 'Payment' as const, Account: signer.address, Destination: dest.address, Amount: '1000000' };
  const receipt = { hash: 'abc', ledger: 1, code: 'tesSUCCESS', meta: { TransactionResult: 'tesSUCCESS' } };
  journal.db.prepare('INSERT INTO operations VALUES (?,?,?,?,?)').run('pay', JSON.stringify(tx), 'blob', 'abc', JSON.stringify(receipt));
  const runner = new Runner(new Client('wss://example.com'), journal);
  try {
    assert.deepEqual(await runner.execute('pay', tx, signer), receipt);
    await assert.rejects(runner.execute('pay', { ...tx, Amount: '2' }, signer), /different request/);
    journal.db.prepare('UPDATE operations SET receipt=? WHERE id=?').run(JSON.stringify({ ...receipt, code: 'tecNO_AUTH' }), 'pay');
    await assert.rejects(runner.execute('pay', tx, signer), TransactionFailure);
  } finally { journal.close(); rmSync(dir, { recursive: true }); }
});

test('issuer policy blocks native-lock exemptions before signing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpt-test-'));
  const journal = new Journal(join(dir, 'db'));
  const wallet = Wallet.generate(), holder = Wallet.generate();
  const id = '00000001' + Buffer.from(decodeAccountID(wallet.address)).toString('hex').toUpperCase();
  const client = new Client('wss://example.com');
  client.getLedgerIndex = async () => 123;
  const issuer = new MptIssuer(new Runner(client, journal), wallet, id);
  issuer.assertConfiguration = async () => {};
  let flags = CAPABILITIES;
  issuer.issuance = async () => ({ LedgerEntryType: 'MPTokenIssuance', Flags: flags, Issuer: wallet.address, Sequence: 1,
    OutstandingAmount: '1', OwnerNode: '0', PreviousTxnID: '', PreviousTxnLgrSeq: 1, index: '' });
  issuer.holder = async () => ({ LedgerEntryType: 'MPToken', Flags: 3, MPTokenIssuanceID: id, MPTAmount: '1', PreviousTxnID: '', PreviousTxnLgrSeq: 1, index: '' });
  try {
    await assert.rejects(issuer.issue(holder.address, '1', 'local'), /Holder is frozen/);
    flags |= 1;
    await assert.rejects(issuer.issue(holder.address, '1', 'global'), /globally frozen/);
    assert.equal(journal.db.prepare('SELECT COUNT(*) AS count FROM operations').get()?.count, 0);
  } finally { journal.close(); rmSync(dir, { recursive: true }); }
});

test('ban persists before ledger work and resumes after partial failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpt-test-'));
  const journal = new Journal(join(dir, 'db'));
  const wallet = Wallet.generate(), holder = Wallet.generate();
  const id = '00000001' + Buffer.from(decodeAccountID(wallet.address)).toString('hex').toUpperCase();
  const runner = new Runner(new Client('wss://example.com'), journal);
  const issuer = new MptIssuer(runner, wallet, id);
  issuer.assertConfiguration = async () => {};
  let flags = 2, balance = '200', fail = true;
  const transactions: string[] = [];
  issuer.holder = async () => ({ LedgerEntryType: 'MPToken', Flags: flags, MPTokenIssuanceID: id, MPTAmount: balance, PreviousTxnID: '', PreviousTxnLgrSeq: 1, index: '' });
  runner.execute = async (_key, tx) => {
    assert.ok(journal.banned(id, holder.address));
    transactions.push(tx.TransactionType);
    if (tx.TransactionType === 'MPTokenIssuanceSet') flags |= 1;
    if (tx.TransactionType === 'MPTokenAuthorize') {
      if (fail) { fail = false; throw new Error('connection lost'); }
      flags &= ~2;
    }
    if (tx.TransactionType === 'Clawback') {
      assert.equal(flags, 1); assert.equal(tx.Holder, holder.address);
      assert.deepEqual(tx.Amount, { mpt_issuance_id: id, value: MAX_AMOUNT });
      balance = '0';
    }
    return { hash: '', ledger: 1, code: 'tesSUCCESS', meta: { TransactionIndex: 0, TransactionResult: 'tesSUCCESS', AffectedNodes: [] } };
  };
  try {
    await assert.rejects(issuer.ban(holder.address, 'case', 'ban'), /connection lost/);
    assert.equal(flags, 3); assert.equal(balance, '200');
    await assert.rejects(issuer.approve(holder.address, 'approve'), /banned/);
    await issuer.ban(holder.address, 'case', 'ban');
    assert.equal(flags, 1); assert.equal(balance, '0');
    assert.deepEqual(transactions, ['MPTokenIssuanceSet', 'MPTokenAuthorize', 'MPTokenIssuanceSet', 'MPTokenAuthorize', 'Clawback']);
  } finally { journal.close(); rmSync(dir, { recursive: true }); }
});

test('zero balances omitted by rippled normalize to zero at a pinned validated ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpt-test-'));
  const journal = new Journal(join(dir, 'db'));
  const wallet = Wallet.generate(), holder = Wallet.generate();
  const id = '00000001' + Buffer.from(decodeAccountID(wallet.address)).toString('hex').toUpperCase();
  const client = new Client('wss://example.com');
  client.request = (async (request: { ledger_index: number }) => {
    assert.equal(request.ledger_index, 123);
    return { result: { validated: true, account_objects: [{ LedgerEntryType: 'MPToken', MPTokenIssuanceID: id, Flags: 1 }] } };
  }) as unknown as typeof client.request;
  try {
    const issuer = new MptIssuer(new Runner(client, journal), wallet, id);
    assert.equal((await issuer.holder(holder.address, 123))?.MPTAmount, '0');
    assert.throws(() => new MptIssuer(new Runner(client, journal), holder, id), /different issuer/);
  } finally { journal.close(); rmSync(dir, { recursive: true }); }
});
