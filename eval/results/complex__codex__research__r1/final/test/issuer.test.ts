import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, Wallet, type SubmittableTransaction } from 'xrpl';
import { amount, CAPABILITIES, MAX_AMOUNT, MptIssuer } from '../src/issuer.js';
import { FileStore } from '../src/store.js';
import { fingerprint, SubmissionUncertain, TransactionRejected, Transactions, type Signer } from '../src/transactions.js';

const issuer = Wallet.generate().classicAddress;
const holder = Wallet.generate().classicAddress;
const mpt = '0'.repeat(48);

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'mpt-test-'));
  const store = new FileStore(directory, issuer);
  let sequence = 1;
  let network = 1;
  let failTransport = false;
  let resultCode = 'tesSUCCESS';
  let holderFlags = 2;
  let issuanceFlags = CAPABILITIES;
  let accountFlags = 0x01000000;
  let hasPreauth = false;
  let fee = '12';
  let balance = '100';
  let calls = 0;
  const submitted: SubmittableTransaction[] = [];
  const validated = new Map<string, unknown>();
  const signer: Signer = { classicAddress: issuer, sign: tx => ({ tx_blob: JSON.stringify(tx), hash: fingerprint(tx) }) };
  const rpc = {
    request: async (req: Record<string, unknown>) => {
      if (req.command === 'server_info') return { result: { info: { network_id: network, validated_ledger: { age: 0 } } } };
      if (req.command === 'feature') return { result: { features: Object.fromEntries(['MPTokensV1', 'Clawback', 'DepositAuth', 'DepositPreauth'].map(name => [name, { enabled: true, name }])) } };
      if (req.command === 'account_info') return { result: { validated: true, ledger_index: 90, account_data: { Flags: accountFlags } } };
      if (req.command === 'account_objects') return { result: { validated: true, account_objects: hasPreauth ? [{ LedgerEntryType: 'DepositPreauth' }] : [] } };
      if (req.command === 'tx') {
        if (validated.has(String(req.transaction))) return validated.get(String(req.transaction));
        throw { data: { error: 'txnNotFound' } };
      }
      if (req.command === 'ledger_entry') return { result: { validated: true, node: req.mpt_issuance ?
        { LedgerEntryType: 'MPTokenIssuance', Issuer: issuer, Flags: issuanceFlags, OutstandingAmount: balance } :
        { LedgerEntryType: 'MPToken', Flags: holderFlags, MPTAmount: balance } } };
      throw new Error('Unexpected request');
    },
    autofill: async (tx: SubmittableTransaction) => ({ ...tx, Fee: fee, Sequence: sequence++, LastLedgerSequence: 100 }),
    submitAndWait: async (blob: string) => {
      calls++;
      const tx = JSON.parse(blob) as SubmittableTransaction;
      submitted.push(tx);
      if (failTransport) throw new Error('Connection lost');
      if (resultCode === 'tesSUCCESS') {
        if (tx.TransactionType === 'MPTokenAuthorize') holderFlags = tx.Flags === 1 ? 0 : 2;
        if (tx.TransactionType === 'Clawback') balance = '0';
      }
      const response = { result: { validated: true, ledger_index: 90, meta: { TransactionResult: resultCode } } };
      validated.set(fingerprint(tx), response);
      return response;
    },
  };
  const tx = new Transactions(rpc as unknown as Client, store);
  return { directory, store, signer, tx, submitted, validated,
    get calls() { return calls; },
    set network(v: number) { network = v; },
    set failTransport(v: boolean) { failTransport = v; },
    set resultCode(v: string) { resultCode = v; },
    set holderFlags(v: number) { holderFlags = v; },
    set issuanceFlags(v: number) { issuanceFlags = v; },
    set accountFlags(v: number) { accountFlags = v; },
    set hasPreauth(v: boolean) { hasPreauth = v; },
    set fee(v: string) { fee = v; },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
const payment = (value = '1'): SubmittableTransaction => ({ TransactionType: 'Payment', Account: issuer, Destination: holder, Amount: value });

test('integer amounts reject rounding, overflow, signs, whitespace, scientific notation and zero', () => {
  assert.equal(amount(MAX_AMOUNT), MAX_AMOUNT);
  for (const value of ['0', '-1', '+1', '01', '1.5', '1e3', ' 1', '9223372036854775808']) assert.throws(() => amount(value));
});
test('store refuses a second writer and wrong issuer', () => {
  const h = harness();
  try {
    assert.throws(() => new FileStore(h.directory, issuer), /EEXIST/);
    h.store.close();
    assert.throws(() => new FileStore(h.directory, holder), /mismatch/);
  } finally { h.close(); }
});
test('validated success is idempotent and changed input is rejected', async () => {
  const h = harness();
  try {
    const receipt = await h.tx.send('payment', payment(), h.signer);
    assert.deepEqual(await h.tx.send('payment', payment(), h.signer), receipt);
    assert.equal(h.calls, 1);
    await assert.rejects(h.tx.send('payment', payment('2'), h.signer), /different transaction/);
  } finally { h.close(); }
});
test('uncertain submission blocks new work and resumes exactly the same signed bytes', async () => {
  const h = harness();
  try {
    h.failTransport = true;
    await assert.rejects(h.tx.send('payment', payment(), h.signer), SubmissionUncertain);
    const blob = h.store.state.transactions.payment!.blob;
    await assert.rejects(h.tx.send('another', payment(), h.signer), /Resolve pending/);
    h.failTransport = false;
    await h.tx.send('payment', payment(), h.signer);
    assert.equal(h.store.state.transactions.payment!.blob, blob);
    assert.deepEqual(h.submitted[0], h.submitted[1]);
  } finally { h.close(); }
});
test('restart reconciles a transaction validated before receipt was persisted without resubmitting', async () => {
  const h = harness();
  try {
    await h.tx.send('payment', payment(), h.signer);
    delete h.store.state.transactions.payment!.receipt;
    h.store.save(); h.store.close();
    const restored = new FileStore(h.directory, issuer);
    try {
      const restarted = new Transactions(h.tx.client, restored);
      await restarted.send('payment', payment(), h.signer);
      assert.equal(h.calls, 1);
    } finally { restored.close(); }
  } finally { h.close(); }
});
test('validated failure is durable and never reported as success', async () => {
  const h = harness();
  try {
    h.resultCode = 'tecNO_AUTH';
    await assert.rejects(h.tx.send('payment', payment(), h.signer), TransactionRejected);
    await assert.rejects(h.tx.send('payment', payment(), h.signer), TransactionRejected);
    assert.equal(h.calls, 1);
  } finally { h.close(); }
});
test('wrong network refuses signing and submission', async () => {
  const h = harness();
  try {
    h.network = 0;
    await assert.rejects(h.tx.send('payment', payment(), h.signer), /outside XRPL testnet/);
    assert.equal(h.calls, 0);
    assert.equal(Object.keys(h.store.state.transactions).length, 0);
  } finally { h.close(); }
});
test('ban revokes before clawback; persisted policy survives a failure and denies approval/unlock', async () => {
  const h = harness();
  try {
    const module = await MptIssuer.attach(h.tx, h.signer, mpt);
    h.failTransport = true;
    await assert.rejects(module.ban(holder, 'KYC withdrawn', 'ban'), SubmissionUncertain);
    assert.equal(h.store.state.bans[`${mpt}:${holder}`]?.completed, false);
    await assert.rejects(module.approve(holder, 'approve'), /banned/);
    await assert.rejects(module.freezeHolder(holder, false, 'unlock'), /banned/);
    await assert.rejects(module.issue(holder, '1', 'mint'), /banned/);
    h.failTransport = false;
    await module.ban(holder, 'KYC withdrawn', 'ban');
    assert.deepEqual(h.submitted.map(tx => tx.TransactionType), ['MPTokenAuthorize', 'MPTokenAuthorize', 'Clawback']);
    assert.equal(h.store.state.bans[`${mpt}:${holder}`]?.completed, true);
    await module.ban(holder, 'KYC withdrawn', 'ban');
    assert.equal(h.calls, 3);
  } finally { h.close(); }
});
test('freeze and global unlock encode the intended Holder scope', async () => {
  const h = harness();
  try {
    const module = await MptIssuer.attach(h.tx, h.signer, mpt);
    await module.freezeHolder(holder, true, 'freeze');
    await module.freezeGlobal(false, 'unlock');
    const [freeze, unlock] = h.submitted;
    assert.equal(freeze?.TransactionType, 'MPTokenIssuanceSet');
    assert.equal(freeze?.Flags, 1);
    assert.equal((freeze as { Holder: string }).Holder, holder);
    assert.equal(unlock?.Flags, 2);
    assert.equal('Holder' in unlock!, false);
  } finally { h.close(); }
});
test('issuer refuses configurations that permit redemption around a freeze', async () => {
  const h = harness();
  try {
    h.accountFlags = 0;
    await assert.rejects(MptIssuer.attach(h.tx, h.signer, mpt), /DepositAuth/);
    h.accountFlags = 0x01000000; h.hasPreauth = true;
    await assert.rejects(MptIssuer.attach(h.tx, h.signer, mpt), /DepositPreauth/);
  } finally { h.close(); }
});
test('issuance policy closes native issuer lock exemptions', async () => {
  const h = harness();
  try {
    const module = await MptIssuer.attach(h.tx, h.signer, mpt);
    h.holderFlags = 3;
    await assert.rejects(module.issue(holder, '1', 'mint-local'), /unlocked/);
    h.holderFlags = 2; h.issuanceFlags = CAPABILITIES | 1;
    await assert.rejects(module.issue(holder, '1', 'mint-global'), /unlocked/);
    h.issuanceFlags = CAPABILITIES; h.holderFlags = 0;
    await assert.rejects(module.issue(holder, '1', 'mint-unauthorized'), /approved/);
    assert.equal(h.calls, 0);
  } finally { h.close(); }
});
test('fee ceiling prevents signing and submission', async () => {
  const h = harness();
  try {
    h.fee = '1001';
    await assert.rejects(h.tx.send('payment', payment(), h.signer), /fee exceeds/);
    assert.equal(h.calls, 0);
  } finally { h.close(); }
});
