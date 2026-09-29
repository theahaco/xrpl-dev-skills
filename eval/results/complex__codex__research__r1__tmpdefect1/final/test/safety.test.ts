import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client, Wallet, decode, hashes, type SubmittableTransaction } from 'xrpl';
import { amount, MAX_AMOUNT, issuanceId, MptIssuer, CAPABILITIES } from '../src/issuer.js';
import { FileStore, SerialQueue } from '../src/store.js';
import { TransactionRunner, walletSigner, REQUIRED_AMENDMENTS } from '../src/ledger.js';

test('amounts are exact and reject rounding, overflow, zero and exponent notation', () => {
  for (const value of ['1', '9007199254740993', MAX_AMOUNT.toString()]) assert.equal(amount(value), value);
  for (const value of ['0', '-1', '01', '1.0', '1e3', ' 1', 'NaN', (MAX_AMOUNT + 1n).toString()]) assert.throws(() => amount(value));
  assert.throws(() => issuanceId('00'));
});

test('exclusive store lock and ban state survive reopening', () => {
  const directory = mkdtempSync(resolve('.private-test-'));
  try {
    const store = new FileStore(directory);
    assert.throws(() => new FileStore(directory));
    store.write('policy', { bans: { holder: { complete: false } } });
    store.close();
    const reopened = new FileStore(directory);
    assert.deepEqual(reopened.read('policy'), { bans: { holder: { complete: false } } });
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('queue serializes concurrent calls and continues after rejected work', async () => {
  const queue = new SerialQueue(); const events: number[] = [];
  const results = await Promise.allSettled([
    queue.run(async () => { await Promise.resolve(); events.push(1); throw new Error('expected'); }),
    queue.run(async () => { events.push(2); }),
  ]);
  assert.equal(results[0]?.status, 'rejected'); assert.deepEqual(events, [1, 2]);
});

test('journal reconciles an uncertain submission without signing or sending twice', async () => {
  const directory = mkdtempSync(resolve('.private-test-'));
  const store = new FileStore(directory);
  try {
    const wallet = Wallet.generate(); const destination = Wallet.generate();
    let signed = 0; let submitted = 0; let validated = false; let transactionHash = '';
    const receipt = () => ({ validated: true, hash: transactionHash, ledger_index: 105,
      meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [] } });
    const client = {
      request: async (request: { command: string }) => {
        if (request.command === 'server_info') return { result: { info: { network_id: 1 } } };
        if (request.command === 'ledger_entry') return { result: { validated: true, node: { LedgerEntryType: 'Amendments', Amendments: Object.values(REQUIRED_AMENDMENTS) } } };
        if (validated) return { result: receipt() };
        throw { data: { error: 'txnNotFound' } };
      },
      autofill: async (transaction: SubmittableTransaction) => ({ ...transaction, Fee: '12', Sequence: 1, LastLedgerSequence: 120 }),
      getLedgerIndex: async () => 100,
      submitAndWait: async () => {
        submitted++;
        const journal = store.read<Record<string, { hash: string }>>('transactions');
        assert.ok(journal?.payment); // Must be durable before submission.
        transactionHash = journal.payment.hash; validated = true;
        throw new Error('socket lost after successful submission');
      },
    } as unknown as Client;
    const delegate = walletSigner(wallet);
    const signer = { address: delegate.address, sign: async (transaction: SubmittableTransaction) => { signed++; return delegate.sign(transaction); } };
    const tx: SubmittableTransaction = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: destination.classicAddress, Amount: '100' };
    const runner = new TransactionRunner(client, store);
    await assert.rejects(runner.submit('payment', tx, signer), /socket lost/);
    await assert.rejects(runner.submit('different', tx, signer), /Reconcile pending/);
    const restarted = new TransactionRunner(client, store);
    assert.equal((await restarted.submit('payment', tx, signer)).code, 'tesSUCCESS');
    assert.equal((await restarted.submit('payment', tx, signer)).hash, transactionHash);
    assert.equal(signed, 1); assert.equal(submitted, 1);
    await assert.rejects(restarted.submit('payment', { ...tx, Amount: '101' }, signer), /different transaction/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('wrong network and disabled amendments fail before signing', async () => {
  const directory = mkdtempSync(resolve('.private-test-'));
  const store = new FileStore(directory);
  try {
    let network = 0;
    const client = { request: async ({ command }: { command: string }) => command === 'server_info' ?
      { result: { info: { network_id: network } } } :
      { result: { validated: true, node: { LedgerEntryType: 'Amendments', Amendments: [] } } },
    } as unknown as Client;
    const runner = new TransactionRunner(client, store);
    await assert.rejects(runner.preflight(), /network_id/);
    network = 1;
    await assert.rejects(runner.preflight(), /Required amendment disabled/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const mode of ['lost response', 'concurrent redemption'] as const) {
test(`ban handles ${mode} and keeps approval denied`, async () => {
  const directory = mkdtempSync(resolve('.private-test-'));
  const store = new FileStore(directory);
  try {
    const issuerWallet = Wallet.generate(); const holder = Wallet.generate().address;
    const id = '00000001' + 'A'.repeat(40);
    store.write('policy', { issuanceId: id, issuer: issuerWallet.address, bans: {} });
    let balance = '100'; let flags = 3; let sequence = 1;
    const receipts = new Map<string, unknown>(); const operations: string[] = [];
    const client = {
      request: async (request: { command: string; index?: string; mpt_issuance?: string; transaction?: string }) => {
        if (request.command === 'server_info') return { result: { info: { network_id: 1 } } };
        if (request.command === 'ledger') return { result: { validated: true, ledger_hash: 'B'.repeat(64), ledger_index: 100 } };
        if (request.command === 'ledger_entry' && request.index) return { result: { validated: true, node: { LedgerEntryType: 'Amendments', Amendments: Object.values(REQUIRED_AMENDMENTS) } } };
        if (request.command === 'ledger_entry' && request.mpt_issuance) return { result: { validated: true, node: { LedgerEntryType: 'MPTokenIssuance', Issuer: issuerWallet.address, Flags: CAPABILITIES, OutstandingAmount: balance } } };
        if (request.command === 'ledger_entry') return { result: { validated: true, node: { LedgerEntryType: 'MPToken', Account: holder, MPTokenIssuanceID: id, Flags: flags, ...(balance === '0' ? {} : { MPTAmount: balance }) } } };
        const result = receipts.get(request.transaction ?? '');
        if (result) return { result };
        throw { data: { error: 'txnNotFound' } };
      },
      autofill: async (transaction: SubmittableTransaction) => ({ ...transaction, Fee: '12', Sequence: sequence++, LastLedgerSequence: 120 }),
      getLedgerIndex: async () => 100,
      submitAndWait: async (blob: string) => {
        const tx = decode(blob); const hash = hashes.hashSignedTx(blob);
        operations.push(String(tx.TransactionType));
        if (tx.TransactionType === 'MPTokenAuthorize') flags &= ~2;
        if (tx.TransactionType === 'Clawback') {
          assert.equal(flags & 2, 0); // Authorization must be revoked before draining.
          assert.deepEqual(tx.Amount, { value: MAX_AMOUNT.toString(), mpt_issuance_id: id });
          balance = '0';
        }
        const code = tx.TransactionType === 'Clawback' && mode === 'concurrent redemption' ? 'tecINSUFFICIENT_FUNDS' : 'tesSUCCESS';
        const result = { hash, validated: true, ledger_index: 101, meta: { TransactionResult: code, TransactionIndex: 0, AffectedNodes: [] } };
        receipts.set(hash, result);
        if (tx.TransactionType === 'Clawback' && mode === 'lost response') throw new Error('lost drain response');
        return { result };
      },
    } as unknown as Client;
    const signer = walletSigner(issuerWallet);
    const issuer = await MptIssuer.open(id, new TransactionRunner(client, store), signer, store);
    if (mode === 'lost response') await assert.rejects(issuer.ban(holder, 'test case'), /lost drain response/);
    else await issuer.ban(holder, 'test case');
    await assert.rejects(issuer.approve(holder, 'reapprove'), /permanently banned/);
    const resumed = await MptIssuer.open(id, new TransactionRunner(client, store), signer, store);
    await resumed.ban(holder, 'test case');
    assert.deepEqual(operations, ['MPTokenAuthorize', 'Clawback']);
    assert.equal((await resumed.inspect([holder])).holders[holder]?.MPTAmount, '0');
    assert.equal(store.read<{ bans: Record<string, { complete: boolean }> }>('policy')?.bans[holder]?.complete, true);
    await assert.rejects(resumed.approve(holder, 'reapprove-again'), /permanently banned/);
    await assert.rejects(resumed.freezeHolder(holder, false, 'unfreeze-banned'), /permanently banned/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
}
