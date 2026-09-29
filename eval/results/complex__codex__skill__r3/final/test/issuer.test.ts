import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Wallet, decode, type SubmittableTransaction } from 'xrpl';
import { amount, MAX_AMOUNT, tokenPayment, REQUIRED_FLAGS, MptIssuer } from '../src/issuer.js';
import { FileState, type StateStore, SerialQueue } from '../src/state.js';
import { TransactionRunner, LedgerFailure } from '../src/transactions.js';

const issuer = Wallet.generate();
const holder = Wallet.generate();
const id = '01234567' + 'AB'.repeat(20);

test('integer amounts reject precision loss, malformed values and overflow', () => {
  for (const bad of ['0','-1','1.1','01','1e3',' 1','+1',(MAX_AMOUNT+1n).toString()]) assert.throws(()=>amount(bad));
  assert.equal(amount(MAX_AMOUNT.toString()),MAX_AMOUNT.toString());
});
test('MPT payment serializes correctly without partial payment flag', () => {
  const tx = tokenPayment(id,issuer.classicAddress,holder.classicAddress,'9007199254740993');
  const decoded = decode(issuer.sign({...tx,Fee:'12',Sequence:1,LastLedgerSequence:10}).tx_blob);
  assert.deepEqual(decoded.Amount,{mpt_issuance_id:id,value:'9007199254740993'});
  assert.equal(decoded.Flags,undefined);
  assert.throws(()=>tokenPayment(id,'bad',holder.classicAddress,'1'));
});
test('durable store excludes concurrent writers and preserves bans', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mpt-test-'));
  try {
    const store=await FileState.open(dir);
    await assert.rejects(FileState.open(dir));
    store.data.bans['token:holder']={reason:'case-1',startedAt:'now',complete:false};
    await store.save(); await store.close();
    const reopened=await FileState.open(dir);
    assert.equal(reopened.data.bans['token:holder']?.reason,'case-1');
    await reopened.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('queue preserves ordering after a rejected operation',async()=>{
  const q=new SerialQueue(); const events:number[]=[];
  const a=q.run(async()=>{events.push(1);throw new Error('expected');});
  const b=q.run(async()=>{events.push(2);});
  await assert.rejects(a); await b; assert.deepEqual(events,[1,2]);
});
function fixture(code='tesSUCCESS') {
  const store:StateStore={data:{version:1,transactions:{},bans:{}},save:async()=>{}};
  let submissions=0; let authorized=true; let balance='200';
  const calls:SubmittableTransaction[]=[];
  const fake={
    request:async(r:Record<string,unknown>)=>{
      if(r.command==='server_info')return {result:{info:{network_id:1,validated_ledger:{reserve_base_xrp:1,reserve_inc_xrp:0.2}}}};
      if(r.command==='account_info')return {result:{validated:true,account_data:{Balance:'100000000',OwnerCount:0}}};
      if(r.command==='tx')throw {data:{error:'txnNotFound'}};
      if(r.mpt_issuance)return {result:{validated:true,node:{LedgerEntryType:'MPTokenIssuance',Issuer:issuer.classicAddress,Flags:REQUIRED_FLAGS}}};
      return {result:{validated:true,node:{LedgerEntryType:'MPToken',MPTAmount:balance,Flags:authorized?2:0}}};
    },
    autofill:async(t:SubmittableTransaction)=>({...t,Sequence:1,Fee:'12',LastLedgerSequence:10}),
    submitAndWait:async(blob:string)=>{
      submissions++; assert(Object.values(store.data.transactions).some(p=>p.blob===blob));
      const tx=decode(blob) as unknown as SubmittableTransaction; calls.push(tx);
      if(tx.TransactionType==='MPTokenAuthorize')authorized=false;
      if(tx.TransactionType==='Clawback')balance='0';
      return {result:{validated:true,ledger_index:2,meta:{TransactionResult:code,AffectedNodes:[],TransactionIndex:0}}};
    }
  };
  return {store,client:fake as unknown as Client,calls,submissions:()=>submissions};
}
test('journal persists before broadcast; duplicate operation cannot spend twice',async()=>{
  const f=fixture();const runner=await TransactionRunner.testnet(f.client,f.store);
  const tx=tokenPayment(id,issuer.classicAddress,holder.classicAddress,'2');
  await runner.send('payment',tx,issuer); await runner.send('payment',tx,issuer);
  assert.equal(f.submissions(),1);
  await assert.rejects(runner.send('payment',{...tx,Destination:Wallet.generate().classicAddress},issuer),/reused/);
});
test('validated tec is persisted and reported as failure',async()=>{
  const f=fixture('tecNO_AUTH');const runner=await TransactionRunner.testnet(f.client,f.store);
  await assert.rejects(runner.send('denied',tokenPayment(id,issuer.classicAddress,holder.classicAddress,'1'),issuer),LedgerFailure);
  assert.equal(f.store.data.transactions.denied?.receipt?.code,'tecNO_AUTH');
});
test('ban revokes before clawback, uses MPT Holder field, and prevents reapproval',async()=>{
  const f=fixture();const runner=await TransactionRunner.testnet(f.client,f.store);
  const mpt=await MptIssuer.connect(runner,issuer,id);
  await mpt.ban(holder.classicAddress,'case-1','ban');
  assert.deepEqual(f.calls.map(t=>t.TransactionType),['MPTokenAuthorize','Clawback']);
  const claw=f.calls[1];assert(claw?.TransactionType==='Clawback');
  assert.equal(claw.Holder,holder.classicAddress);
  assert.deepEqual(claw.Amount,{mpt_issuance_id:id,value:MAX_AMOUNT.toString()});
  await assert.rejects(mpt.approve(holder.classicAddress,'approve'),/banned/);
  await assert.rejects(mpt.unfreezeHolder(holder.classicAddress,'unlock'),/banned/);
  await mpt.ban(holder.classicAddress,'case-1','ban');
  assert.equal(f.submissions(),2);
});
test('incomplete ban persists denial before any ledger transaction',async()=>{
  const f=fixture(); const runner=await TransactionRunner.testnet(f.client,f.store);
  const mpt=await MptIssuer.connect(runner,issuer,id);
  f.client.autofill=async()=>{throw new Error('offline');};
  await assert.rejects(mpt.ban(holder.classicAddress,'case-2','ban'),/offline/);
  assert.equal(f.store.data.bans[`${id}:${holder.classicAddress}`]?.complete,false);
  await assert.rejects(mpt.approve(holder.classicAddress,'approve'),/banned/);
});
test('uncertain submission blocks new spending and resumes original signed blob',async()=>{
  const f=fixture();const runner=await TransactionRunner.testnet(f.client,f.store);
  const submit=f.client.submitAndWait.bind(f.client);
  f.client.submitAndWait=async()=>{throw new Error('connection lost');};
  const tx=tokenPayment(id,issuer.classicAddress,holder.classicAddress,'2');
  await assert.rejects(runner.send('uncertain',tx,issuer),/Outcome unresolved/);
  const hash=f.store.data.transactions.uncertain?.hash;
  await assert.rejects(runner.send('new-payment',tx,issuer),/Unresolved transaction/);
  f.client.submitAndWait=submit;
  await runner.send('uncertain',tx,issuer);
  assert.equal(f.store.data.transactions.uncertain?.receipt?.hash,hash);
  assert.equal(f.submissions(),1);
});
test('unvalidated tesSUCCESS cannot be treated as settled',async()=>{
  const f=fixture();const runner=await TransactionRunner.testnet(f.client,f.store);
  f.client.submitAndWait=async()=>({result:{validated:false,ledger_index:2,meta:{TransactionResult:'tesSUCCESS',AffectedNodes:[],TransactionIndex:0}}}) as never;
  await assert.rejects(runner.send('unvalidated',tokenPayment(id,issuer.classicAddress,holder.classicAddress,'2'),issuer),/Unvalidated/);
  assert.equal(f.store.data.transactions.unvalidated?.receipt,undefined);
});
test('fee cap and missing expiry fail before signing and broadcasting',async()=>{
  for(const patch of [{Fee:'10001'},{LastLedgerSequence:0}]) {
    const f=fixture();const runner=await TransactionRunner.testnet(f.client,f.store);
    f.client.autofill=async(t)=>({...t,Sequence:1,Fee:'12',LastLedgerSequence:10,...patch});
    await assert.rejects(runner.send('unsafe',tokenPayment(id,issuer.classicAddress,holder.classicAddress,'2'),issuer),/expiry or excessive fee/);
    assert.equal(f.submissions(),0);
  }
});
test('network guard refuses mainnet',async()=>{
  const client={request:async()=>({result:{info:{network_id:0}}})} as unknown as Client;
  await assert.rejects(TransactionRunner.testnet(client,fixture().store),/non-testnet/);
});
