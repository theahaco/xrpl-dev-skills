import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { Client, Wallet, xrpToDrops } from 'xrpl';
import { FileState, TransactionRunner, TESTNET, MptIssuer, tokenPayment, LedgerFailure } from './index.js';
import { ISSUER, verify, type DemoResult } from './verify.js';

const seed = process.env.ISSUER_SEED;
if (!seed) throw new Error('Set ISSUER_SEED in the environment');
const issuerWallet = Wallet.fromSeed(seed);
assert.equal(issuerWallet.classicAddress, ISSUER, 'Wrong issuer seed');
const state = await FileState.open('.state');
const client = new Client(TESTNET, { maxFeeXRP: '0.01', timeout: 30_000 });
try {
  await client.connect();
  const runner = await TransactionRunner.testnet(client, state);
  const info = (await client.request({command:'server_info'})).result.info;
  console.log('Validated testnet reserves:', info.validated_ledger);
  state.data.demoSalt ??= randomBytes(32).toString('hex');
  await state.save();
  // Reproducible holders after a restart without storing private keys or seeds on disk.
  const holders = Object.fromEntries((['A','B','C'] as const).map(name => [name,
    Wallet.fromEntropy(createHmac('sha256', seed).update(`mpt-demo:${state.data.demoSalt}:${name}`).digest().subarray(0,16))
  ])) as Record<'A'|'B'|'C', Wallet>;
  for (const name of ['A','B','C'] as const) {
    await runner.send(`fund/${name}`, { TransactionType:'Payment', Account:ISSUER, Destination:holders[name].classicAddress, Amount:xrpToDrops('3') }, issuerWallet);
  }
  const issuer = await MptIssuer.create(runner, issuerWallet, 'create', {maximumAmount:'1000000000', assetScale:0});
  const result: DemoResult = {issuanceId:issuer.id, holders:{A:holders.A.classicAddress,B:holders.B.classicAddress,C:holders.C.classicAddress}};
  console.log('Issuance:', issuer.id, 'Holders:', result.holders);
  for (const name of ['A','B','C'] as const) {
    await runner.send(`opt-in/${name}`, {TransactionType:'MPTokenAuthorize', Account:holders[name].classicAddress, MPTokenIssuanceID:issuer.id}, holders[name]);
  }
  const rejected: {operation:string; code:string; hash:string}[] = [];
  async function blocked(operation:string, from:Wallet, to:Wallet, codes:readonly string[]) {
    try {
      await runner.send(operation, tokenPayment(issuer.id,from.classicAddress,to.classicAddress,'1'),from);
      assert.fail(`Unexpected successful transfer: ${operation}`);
    } catch(error) {
      if (!(error instanceof LedgerFailure)) throw error;
      assert(codes.includes(error.receipt.code), `${operation}: unexpected ${error.receipt.code}`);
      rejected.push({operation,code:error.receipt.code,hash:error.receipt.hash});
    }
  }
  await blocked('deny/unapproved',issuerWallet,holders.C,['tecNO_AUTH']);
  for (const name of ['A','B','C'] as const) {
    if (!state.data.transactions[`approve/${name}`]?.receipt) await issuer.approve(holders[name].classicAddress,`approve/${name}`);
  }
  // Runner's durable mint IDs make demo restart safe even after later freezes/bans.
  for (const [name,value] of [['A','500'],['B','1000'],['C','200']] as const) {
    await runner.send(`mint/${name}`,tokenPayment(issuer.id,ISSUER,holders[name].classicAddress,value),issuerWallet);
  }
  await issuer.freezeHolder(holders.A.classicAddress,'freeze/A');
  await blocked('deny/A-send',holders.A,holders.B,['tecLOCKED']);
  await blocked('deny/A-receive',holders.B,holders.A,['tecLOCKED']);
  // Demonstrate the redemption exception using a real payment, then restore the balance.
  await runner.send('exception/A-redemption',tokenPayment(issuer.id,holders.A.classicAddress,ISSUER,'1'),holders.A);
  await issuer.unfreezeHolder(holders.A.classicAddress,'unfreeze/A');
  await runner.send('restore/A',tokenPayment(issuer.id,ISSUER,holders.A.classicAddress,'1'),issuerWallet);
  await runner.send('transfer/A-B',tokenPayment(issuer.id,holders.A.classicAddress,holders.B.classicAddress,'1'),holders.A);
  await runner.send('transfer/B-A',tokenPayment(issuer.id,holders.B.classicAddress,holders.A.classicAddress,'1'),holders.B);
  await issuer.clawback(holders.B.classicAddress,'300','clawback/B');
  await issuer.freezeAll('freeze/global');
  await blocked('deny/global-A-B',holders.A,holders.B,['tecLOCKED']);
  await blocked('deny/global-B-A',holders.B,holders.A,['tecLOCKED']);
  await runner.send('exception/global-redemption',tokenPayment(issuer.id,holders.A.classicAddress,ISSUER,'1'),holders.A);
  await issuer.unfreezeAll('unfreeze/global');
  await runner.send('restore/global-A',tokenPayment(issuer.id,ISSUER,holders.A.classicAddress,'1'),issuerWallet);
  await issuer.freezeHolder(holders.B.classicAddress,'freeze/B');
  await blocked('deny/B-send',holders.B,holders.A,['tecLOCKED']);
  await blocked('deny/B-receive',holders.A,holders.B,['tecLOCKED']);
  await issuer.ban(holders.C.classicAddress,'demo compliance ban','ban/C');
  await blocked('deny/banned-peer',holders.A,holders.C,['tecNO_AUTH']);
  await blocked('deny/banned-issuer',issuerWallet,holders.C,['tecNO_AUTH']);
  // C cannot self-approve by removing/recreating the holding.
  await runner.send('C/delete', {TransactionType:'MPTokenAuthorize',Account:holders.C.classicAddress,MPTokenIssuanceID:issuer.id,Flags:1},holders.C);
  await runner.send('C/recreate', {TransactionType:'MPTokenAuthorize',Account:holders.C.classicAddress,MPTokenIssuanceID:issuer.id},holders.C);
  await blocked('deny/banned-recreated',holders.A,holders.C,['tecNO_AUTH']);
  await assert.rejects(issuer.approve(holders.C.classicAddress,'forbidden/reapprove'),/banned/);
  const snapshot = await verify(client,result);
  await writeFile('verification.json',JSON.stringify({...snapshot, rejected, transactions:Object.fromEntries(Object.entries(state.data.transactions).map(([id,p])=>[id,p.receipt]))},null,2)+'\n');
  await writeFile('result.tmp',JSON.stringify(result,null,2)+'\n');
  await rename('result.tmp','result.json');
  console.log(`Demo complete; final state verified at ledger ${snapshot.ledgerIndex}`);
} finally {
  await client.disconnect();
  await state.close();
}
