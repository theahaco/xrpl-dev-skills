import assert from 'node:assert/strict';
import { writeFileSync, renameSync } from 'node:fs';
import { Client, Wallet, MPTokenAuthorizeFlags } from 'xrpl';
import { MptIssuer, TESTNET, assertTestnet } from './issuer.js';
import { Store } from './store.js';
import { Submitter, LedgerFailure } from './submitter.js';
import { verify, ISSUER_ADDRESS } from './verification.js';
import type { DemoResult } from './verification.js';

process.umask(0o077);
const seed = process.env['XRPL_ISSUER_SEED'];
if (!seed) throw new Error('Set XRPL_ISSUER_SEED to the supplied testnet issuer seed');
const wallet = Wallet.fromSeed(seed);
assert.equal(wallet.classicAddress,ISSUER_ADDRESS,'Unexpected issuer');
const client = new Client(TESTNET,{maxFeeXRP:'0.01',timeout:20000});
const store = new Store('.private/demo.sqlite');
const submitter = new Submitter(client,store);
const writeJSON = (path:string,data:unknown): void => {writeFileSync(`${path}.tmp`,JSON.stringify(data,null,2)+'\n');renameSync(`${path}.tmp`,path);};
async function step(id: string, fn: () => Promise<void>): Promise<void> {
  if (store.get<boolean>(`step:${id}`)) return;
  await fn(); store.set(`step:${id}`,true);
}
try {
  await client.connect();
  writeJSON('research/run-network.json',await assertTestnet(client));
  let secrets = store.get<Record<'A'|'B'|'C',string>>('holders');
  if (!secrets) {
    secrets = {A:Wallet.generate().seed!,B:Wallet.generate().seed!,C:Wallet.generate().seed!};
    store.set('holders',secrets);
  }
  const holders = {A:Wallet.fromSeed(secrets.A),B:Wallet.fromSeed(secrets.B),C:Wallet.fromSeed(secrets.C)};
  for (const [name,h] of Object.entries(holders)) await step(`fund-${name}`,async () => {
    await submitter.exclusive(()=>submitter.send(`fund-${name}`,{TransactionType:'Payment',Account:wallet.classicAddress,Destination:h.classicAddress,Amount:'10000000'},wallet));
  });
  let savedId = store.get<string>('issuanceId');
  if (!savedId) { savedId = (await MptIssuer.create(submitter,wallet,'demo-issuance')).id; store.set('issuanceId',savedId); }
  const id = savedId;
  const issuer = new MptIssuer(submitter,wallet,id);
  for (const [name,h] of Object.entries(holders)) await step(`opt-in-${name}`,async () => {
    await submitter.exclusive(()=>submitter.send(`opt-in-${name}`,{TransactionType:'MPTokenAuthorize',Account:h.classicAddress,MPTokenIssuanceID:id},h));
  });
  async function payment(op:string,from:Wallet,to:string,value:string,expectedCodes?:string[]):Promise<void> {
    await step(op,async () => {
      try {
        await submitter.exclusive(()=>submitter.send(op,{TransactionType:'Payment',Account:from.classicAddress,Destination:to,Amount:{mpt_issuance_id:id,value}},from));
        assert(!expectedCodes,`${op} unexpectedly succeeded`);
      } catch(e) {
        if (!(e instanceof LedgerFailure) || !expectedCodes?.includes(e.receipt.code)) throw e;
      }
    });
  }
  await payment('reject-unapproved',wallet,holders.C.classicAddress,'1',['tecNO_AUTH']);
  for (const [name,h] of Object.entries(holders)) {
    await step(`approve-${name}`,()=>issuer.approve(h.classicAddress,`approve-${name}`));
    await step(`issue-${name}`,()=>issuer.issue(h.classicAddress,name === 'A' ? '500' : name === 'B' ? '1000' : '200',`issue-${name}`));
  }
  await step('freeze-A',()=>issuer.freezeHolder(holders.A.classicAddress,true,'freeze-A'));
  await payment('reject-A-send',holders.A,holders.B.classicAddress,'1',['tecLOCKED']);
  await payment('reject-A-receive',holders.B,holders.A.classicAddress,'1',['tecLOCKED']);
  await payment('reject-A-redemption',holders.A,wallet.classicAddress,'1',['tecNO_PERMISSION']);
  await step('unfreeze-A',()=>issuer.freezeHolder(holders.A.classicAddress,false,'unfreeze-A'));
  await payment('A-send-after-unfreeze',holders.A,holders.B.classicAddress,'1');
  await payment('A-receive-after-unfreeze',holders.B,holders.A.classicAddress,'1');
  await step('clawback-B-300',()=>issuer.clawback(holders.B.classicAddress,'300','clawback-B-300'));
  await step('freeze-global',()=>issuer.freezeGlobal(true,'freeze-global'));
  await payment('reject-global-transfer',holders.A,holders.B.classicAddress,'1',['tecLOCKED']);
  await payment('reject-global-redemption',holders.A,wallet.classicAddress,'1',['tecNO_PERMISSION']);
  await step('reject-module-mint-global',async()=>{await assert.rejects(issuer.issue(holders.A.classicAddress,'1','blocked-mint'),/frozen/);});
  await step('unfreeze-global',()=>issuer.freezeGlobal(false,'unfreeze-global'));
  await payment('transfer-after-global-unfreeze',holders.A,holders.B.classicAddress,'1');
  await payment('restore-after-global-unfreeze',holders.B,holders.A.classicAddress,'1');
  await step('freeze-B',()=>issuer.freezeHolder(holders.B.classicAddress,true,'freeze-B'));
  await step('ban-C',()=>issuer.ban(holders.C.classicAddress,'Demo compliance ban','ban-C'));
  await payment('reject-banned-peer-receive',holders.A,holders.C.classicAddress,'1',['tecNO_AUTH','tecLOCKED']);
  await payment('reject-banned-issuer-receive',wallet,holders.C.classicAddress,'1',['tecNO_AUTH','tecLOCKED']);
  await step('C-delete-and-recreate',async()=>{
    let deleted = true;
    try {
      await submitter.exclusive(()=>submitter.send('C-delete-entry',{TransactionType:'MPTokenAuthorize',Account:holders.C.classicAddress,
        MPTokenIssuanceID:id,Flags:MPTokenAuthorizeFlags.tfMPTUnauthorize},holders.C));
    } catch(e) {if (!(e instanceof LedgerFailure) || e.receipt.code !== 'tecNO_PERMISSION') throw e; deleted=false;}
    if (deleted) await submitter.exclusive(()=>submitter.send('C-recreate-entry',{TransactionType:'MPTokenAuthorize',Account:holders.C.classicAddress,MPTokenIssuanceID:id},holders.C));
  });
  await payment('reject-recreated-C-receive',holders.A,holders.C.classicAddress,'1',['tecNO_AUTH','tecLOCKED']);
  await step('reject-ban-policy-bypass',async()=>{
    await assert.rejects(issuer.approve(holders.C.classicAddress,'bad-reapprove-C'),/banned/);
    await assert.rejects(issuer.freezeHolder(holders.C.classicAddress,false,'bad-unfreeze-C'),/banned/);
    await assert.rejects(issuer.issue(holders.C.classicAddress,'1','bad-issue-C'),/banned/);
  });
  const result:DemoResult = {issuanceId:id,holders:{A:holders.A.classicAddress,B:holders.B.classicAddress,C:holders.C.classicAddress}};
  await issuer.assertConfiguration();
  writeJSON('verification.json',await verify(client,result));
  writeJSON('audit.json',store.audit());
  writeJSON('result.json',result);
  console.log('Verified all final balances and controls; result.json written.');
} finally {
  writeJSON('audit.json',store.audit());
  await client.disconnect(); store.close();
}
