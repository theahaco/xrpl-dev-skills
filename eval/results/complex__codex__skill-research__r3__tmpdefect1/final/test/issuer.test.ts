import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { Client, Wallet, encode, decode, type SubmittableTransaction } from 'xrpl';
import { Journal } from '../src/journal.js';
import { Ledger, resultCode, requireSuccess } from '../src/ledger.js';
import { amount, MAX_AMOUNT, creation, CAPABILITIES, holderAddress, MptIssuer } from '../src/issuer.js';

mkdirSync('.tmp',{recursive:true});

test('amounts preserve integer precision and reject malformed or out-of-range values', () => {
  assert.equal(amount(MAX_AMOUNT),'9223372036854775807');
  for (const value of ['0','-1','1.1','1e3','01',' 1','9223372036854775808']) assert.throws(() => amount(value));
});
test('issuance serializes required capabilities and excludes escrow/trade/confidential', () => {
  const w = Wallet.generate();
  const tx = creation(w.classicAddress,'1000000',0);
  const decoded = decode(encode({...tx,Sequence:1,Fee:'10',LastLedgerSequence:100,SigningPubKey:w.publicKey}));
  assert.equal(decoded.Flags,102);
  assert.equal(decoded.Flags,CAPABILITIES);
  assert.equal(decoded.MaximumAmount,'1000000');
  assert.throws(() => creation(w.classicAddress,'1',-1));
  assert.throws(() => holderAddress(w.classicAddress,w.classicAddress));
  assert.throws(() => holderAddress('not-an-address',w.classicAddress));
});
test('journal enforces process ownership and bans survive restart', () => {
  const dir = mkdtempSync('.tmp/journal-');
  const path = `${dir}/db`;
  let journal = new Journal(path);
  try {
    journal.ban('issuance','holder','case-123');
    assert.throws(() => new Journal(path));
    journal.close(); journal = new Journal(path);
    assert.equal(journal.banned('issuance','holder'),true);
    assert.equal(journal.banned('other','holder'),false);
  } finally { journal.close(); rmSync(dir,{recursive:true}); }
});
test('ambiguous submission retains signed bytes; retries do not duplicate transaction', async () => {
  const dir = mkdtempSync('.tmp/submission-');
  const journal = new Journal(`${dir}/db`);
  const client = new Client('wss://example.com');
  const ledger = new Ledger(client,journal);
  const w = Wallet.generate();
  const tx: SubmittableTransaction = {TransactionType:'Payment',Account:w.classicAddress,Destination:Wallet.generate().classicAddress,Amount:'1000000'};
  mock.method(client,'autofill',async (t: SubmittableTransaction) => ({...t,Fee:'10',Sequence:1,LastLedgerSequence:100}));
  const blobs: string[] = [];
  let fail = true;
  mock.method(client,'submitAndWait',async (blob: string) => {
    blobs.push(blob);
    if (fail) throw new Error('timeout');
    const row = journal.db.prepare('SELECT hash FROM tx WHERE id=?').get('one');
    return {result:{hash:row?.hash,validated:true,meta:{TransactionResult:'tesSUCCESS'}}};
  });
  mock.method(client,'request',async () => { throw new Error('not yet found'); });
  try {
    await assert.rejects(ledger.send('one',w,tx),/Unresolved/);
    await assert.rejects(ledger.send('two',w,tx),/Unresolved/);
    fail = false;
    requireSuccess(await ledger.send('one',w,tx));
    assert.equal(blobs[0],blobs[1]);
    requireSuccess(await ledger.send('one',w,tx));
    assert.equal(blobs.length,2);
    await assert.rejects(ledger.send('one',w,{...tx,Amount:'2'}),/conflict/);
  } finally { journal.close(); rmSync(dir,{recursive:true}); mock.restoreAll(); }
});
test('ban intent survives failure before on-ledger revocation and blocks approval/unfreeze', async () => {
  const dir = mkdtempSync('.tmp/ban-');
  const journal = new Journal(`${dir}/db`);
  const ledger = new Ledger(new Client('wss://example.com'),journal);
  const token = new MptIssuer(ledger,Wallet.generate(),'0'.repeat(48));
  const holder = Wallet.generate().classicAddress;
  mock.method(token,'assertProfile',async () => { throw new Error('network unavailable'); });
  try {
    await assert.rejects(token.ban('ban',holder,'case-1'),/network/);
    assert.equal(journal.banned(token.issuanceId,holder),true);
    await assert.rejects(token.approve('approve',holder,'case-2'),/banned/);
    await assert.rejects(token.freeze('unlock',holder,false),/banned/);
  } finally { journal.close(); rmSync(dir,{recursive:true}); mock.restoreAll(); }
});
test('only validated success is accepted', () => {
  const make = (validated: boolean, code: string) => ({validated,hash:'ABC',meta:{TransactionResult:code}}) as Parameters<typeof resultCode>[0];
  assert.throws(() => requireSuccess(make(false,'tesSUCCESS')),/validated/);
  assert.throws(() => requireSuccess(make(true,'tecNO_AUTH')),/tecNO_AUTH/);
  requireSuccess(make(true,'tesSUCCESS'));
});

test('issuer mint guard rejects both kinds of lock BEFORE signing', async () => {
  const dir = mkdtempSync('.tmp/locks-');
  const journal = new Journal(`${dir}/db`);
  const ledger = new Ledger(new Client('wss://example.com'),journal);
  const token = new MptIssuer(ledger,Wallet.generate(),'0'.repeat(48));
  const holder = Wallet.generate().classicAddress;
  let global = false;
  mock.method(token,'assertProfile',async () => undefined);
  mock.method(token,'issuance',async () => ({Flags:CAPABILITIES | (global ? 1 : 0)}));
  mock.method(token,'holder',async () => ({Flags:global ? 2 : 3,MPTAmount:'700'}));
  const submit = mock.method(ledger,'send',async () => { throw new Error('Should never sign'); });
  try {
    await assert.rejects(token.mint('individual',holder,'1'),/unlocked/);
    global = true;
    await assert.rejects(token.mint('global',holder,'1'),/unlocked/);
    assert.equal(submit.mock.callCount(),0);
  } finally { journal.close(); rmSync(dir,{recursive:true}); mock.restoreAll(); }
});

test('ban revokes before lock and drain, and interruption leaves a resumable durable ban', async () => {
  const dir = mkdtempSync('.tmp/saga-');
  const journal = new Journal(`${dir}/db`);
  const ledger = new Ledger(new Client('wss://example.com'),journal);
  const token = new MptIssuer(ledger,Wallet.generate(),'0'.repeat(48));
  const holder = Wallet.generate().classicAddress;
  const calls: SubmittableTransaction[] = [];
  let failRevoke = true;
  let balance = '200';
  let flags = 2;
  mock.method(token,'assertProfile',async () => undefined);
  mock.method(token,'holder',async () => ({MPTAmount:balance,Flags:flags}));
  mock.method(ledger,'send',async (_id: string, _signer: Wallet, tx: SubmittableTransaction) => {
    calls.push(tx);
    if (failRevoke) throw new Error('interrupted');
    if (tx.TransactionType === 'MPTokenAuthorize') { assert.equal(tx.Flags,1); flags = 0; }
    if (tx.TransactionType === 'MPTokenIssuanceSet') flags |= 1;
    if (tx.TransactionType === 'Clawback') {
      assert.equal(tx.Holder,holder);
      assert.deepEqual(tx.Amount,{mpt_issuance_id:token.issuanceId,value:MAX_AMOUNT});
      balance = '0';
    }
    return {validated:true,hash:'ABC',meta:{TransactionResult:'tesSUCCESS'}};
  });
  try {
    await assert.rejects(token.ban('ban',holder,'case-1'),/interrupted/);
    assert.equal(calls.length,1);
    assert.equal(journal.banned(token.issuanceId,holder),true);
    failRevoke = false;
    await token.ban('ban',holder,'case-1');
    assert.deepEqual(calls.slice(1).map(tx => tx.TransactionType),['MPTokenAuthorize','MPTokenIssuanceSet','Clawback']);
    assert.equal(balance,'0');
    assert.equal(flags,1);
  } finally { journal.close(); rmSync(dir,{recursive:true}); mock.restoreAll(); }
});

test('zero balances omitted by rippled are normalized before compliance decisions', async () => {
  const dir = mkdtempSync('.tmp/zero-');
  const journal = new Journal(`${dir}/db`);
  const ledger = new Ledger(new Client('wss://example.com'),journal);
  const token = new MptIssuer(ledger,Wallet.generate(),'0'.repeat(48));
  mock.method(ledger,'entry',async () => ({LedgerEntryType:'MPToken',Flags:0,MPTokenIssuanceID:token.issuanceId}));
  try { assert.equal((await token.holder(Wallet.generate().classicAddress))?.MPTAmount,'0'); }
  finally { journal.close(); rmSync(dir,{recursive:true}); mock.restoreAll(); }
});
