import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { Client, Wallet, type SubmittableTransaction } from 'xrpl';
import { Store, Transactions, LedgerFailure, amount, MAX_AMOUNT, MptIssuer, CAPABILITIES, type Signer } from '../src/index.js';

const wallet = Wallet.generate();
const holder = Wallet.generate().classicAddress;
const tx: SubmittableTransaction = {TransactionType:'Payment',Account:wallet.classicAddress,Destination:holder,Amount:'1000000'};
function fixture() {
  mkdirSync('.private',{recursive:true});
  const dir = mkdtempSync('.private/test-');
  const store = new Store(`${dir}/state.sqlite`);
  let submissions = 0;
  let signatures = 0;
  let code = 'tesSUCCESS';
  let fail = false;
  let network = 1;
  let validated = true;
  const fake = {
    request: async (request: {command:string}) => {
      if (request.command === 'server_info') return {result:{info:{network_id:network}}};
      throw Object.assign(new Error('not found'),{data:{error:'txnNotFound'}});
    },
    autofill: async (transaction: SubmittableTransaction) => ({...transaction,Sequence:1,Fee:'10',LastLedgerSequence:100}),
    submitAndWait: async () => {
      submissions++;
      if (fail) throw new Error('connection lost after submit');
      return {result:{validated,ledger_index:5,meta:{TransactionResult:code,AffectedNodes:[],TransactionIndex:0}}};
    },
  };
  const signer: Signer = {address:wallet.classicAddress,sign:async () => {signatures++;return {tx_blob:'SIGNED',hash:'HASH'};}};
  return {dir,store,runner:new Transactions(fake as unknown as Client,store),signer,
    submissions:()=>submissions, signatures:()=>signatures,
    setCode:(value:string)=>{code=value;}, setFail:(value:boolean)=>{fail=value;},
    setNetwork:(value:number)=>{network=value;},setValidated:(value:boolean)=>{validated=value;},
    close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('amounts reject rounding, negatives, zero and overflow', () => {
  for (const value of ['0','-1','1.1','1e3','01',' 1','9223372036854775808']) assert.throws(()=>amount(value));
  assert.equal(amount(MAX_AMOUNT.toString()),MAX_AMOUNT.toString());
});
test('concurrent retries submit and sign once; conflicting reuse fails', async () => {
  const f=fixture(); try {
    await Promise.all([f.runner.submit('one',tx,f.signer),f.runner.submit('one',tx,f.signer)]);
    assert.equal(f.submissions(),1); assert.equal(f.signatures(),1);
    await assert.rejects(f.runner.submit('one',{...tx,Amount:'2'},f.signer),/different intent/);
  } finally {f.close();}
});
test('unknown outcome blocks other operations and retries same signed bytes', async () => {
  const f=fixture(); try {
    f.setFail(true);
    await assert.rejects(f.runner.submit('one',tx,f.signer),/connection lost/);
    await assert.rejects(f.runner.submit('two',tx,f.signer),/pending operation/);
    f.setFail(false); await f.runner.submit('one',tx,f.signer);
    assert.equal(f.signatures(),1); assert.equal(f.submissions(),2);
  } finally {f.close();}
});
test('validated tec is persisted as failure and never reissued', async () => {
  const f=fixture(); try {
    f.setCode('tecNO_AUTH');
    await assert.rejects(f.runner.submit('one',tx,f.signer),LedgerFailure);
    await assert.rejects(f.runner.submit('one',tx,f.signer),LedgerFailure);
    assert.equal(f.submissions(),1); assert.equal(f.store.get('unresolved'),null);
  } finally {f.close();}
});
test('network and validated-result guards fail closed', async () => {
  const f=fixture(); try {
    f.setNetwork(0); await assert.rejects(f.runner.submit('one',tx,f.signer),/outside XRPL testnet/);
    assert.equal(f.signatures(),0);
    f.setNetwork(1); f.setValidated(false);
    await assert.rejects(f.runner.submit('one',tx,f.signer),/Uncertain/);
    assert.equal(f.store.get('unresolved'),'one');
  } finally {f.close();}
});
test('store is durable and enforces exclusive ownership', () => {
  const f=fixture();
  f.store.set('ban',{status:'pending'});
  assert.throws(()=>new Store(`${f.dir}/state.sqlite`),/EEXIST/);
  f.store.close();
  const reopened=new Store(`${f.dir}/state.sqlite`);
  try { assert.deepEqual(reopened.get('ban'),{status:'pending'}); }
  finally {reopened.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('ban revokes before drain, persists through failure, and blocks reapproval', async () => {
  const f=fixture();
  let balance='200'; let flags=2; let failDrain=true;
  const calls:string[]=[];
  const fake={
    request:async (request:{command:string;mpt_issuance?:string}) => request.command==='server_info'
      ? {result:{info:{network_id:1}}}
      : {result:{validated:true,node: request.mpt_issuance
        ? {LedgerEntryType:'MPTokenIssuance',Issuer:wallet.classicAddress,Flags:CAPABILITIES}
        : {LedgerEntryType:'MPToken',MPTAmount:balance,Flags:flags}}},
  };
  const runner=new Transactions(fake as unknown as Client,f.store);
  runner.submit=async (_key, transaction) => {
    calls.push(transaction.TransactionType);
    if (transaction.TransactionType==='MPTokenAuthorize') flags &= ~2;
    if (transaction.TransactionType==='MPTokenIssuanceSet') flags |= 1;
    if (transaction.TransactionType==='Clawback') {
      assert.equal(flags,1); assert.equal(transaction.Holder,holder);
      assert.equal((transaction.Amount as {value:string}).value,MAX_AMOUNT.toString());
      if (failDrain) throw new Error('drain interrupted');
      balance='0';
    }
    return {hash:'HASH',ledgerIndex:1,code:'tesSUCCESS',meta:{TransactionResult:'tesSUCCESS',TransactionIndex:0,AffectedNodes:[]}};
  };
  try {
    const issuer=await MptIssuer.open(runner,f.signer,'A'.repeat(48));
    await assert.rejects(issuer.ban(holder),/interrupted/);
    assert.deepEqual(calls,['MPTokenAuthorize','MPTokenIssuanceSet','Clawback']);
    await assert.rejects(issuer.approve(holder,'approve'),/permanently banned/);
    await assert.rejects(issuer.mint(holder,'1','mint'),/permanently banned/);
    await assert.rejects(issuer.freezeHolder(holder,false,'unlock'),/permanently banned/);
    failDrain=false; const state=await issuer.ban(holder);
    assert.equal(state.balance,'0'); assert.equal(state.authorized,false);
    const reopened=await MptIssuer.open(runner,f.signer,'A'.repeat(48));
    await assert.rejects(reopened.approve(holder,'approve-again'),/permanently banned/);
  } finally {f.close();}
});
