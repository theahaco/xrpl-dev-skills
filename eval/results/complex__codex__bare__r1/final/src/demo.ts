import assert from 'node:assert/strict';
import { writeFile, rename } from 'node:fs/promises';
import { Client, Wallet, type SubmittableTransaction } from 'xrpl';
import { Store, Transactions, MptIssuer, LedgerFailure, walletSigner } from './index.js';
import { verify, ISSUER_ADDRESS, TESTNET_URL, type DemoResult } from './verification.js';

const seed = process.env.ISSUER_SEED;
if (!seed) throw new Error('Set ISSUER_SEED to the testnet issuer seed');
const issuerWallet = Wallet.fromSeed(seed);
assert.equal(issuerWallet.classicAddress, ISSUER_ADDRESS, 'Unexpected issuer');
const client = new Client(TESTNET_URL);
const store = new Store('.private/demo.sqlite');
const txs = new Transactions(client, store);
const issuerSigner = walletSigner(issuerWallet);
const evidence = store.get<Record<string, unknown>>('evidence') ?? {};
async function step(name: string, action: () => Promise<unknown>): Promise<void> {
  if (store.get(`step:${name}`)) return;
  const value = await action();
  evidence[name] = value ?? true;
  store.set('evidence', evidence);
  store.set(`step:${name}`, true);
}
async function blocked(name: string, action: () => Promise<unknown>, codes: string[]): Promise<unknown> {
  try { await action(); } catch (error) {
    if (error instanceof LedgerFailure && codes.includes(error.receipt.code)) return error.receipt;
    throw error;
  }
  throw new Error(`${name}: ledger unexpectedly allowed the payment`);
}
try {
  await client.connect(); await txs.checkTestnet();
  const holders = {} as Record<'A' | 'B' | 'C', Wallet>;
  for (const name of ['A','B','C'] as const) {
    let holderSeed = store.get<string>(`seed:${name}`);
    if (!holderSeed) {
      holderSeed = Wallet.generate().seed;
      assert(holderSeed); store.set(`seed:${name}`, holderSeed);
    }
    holders[name] = Wallet.fromSeed(holderSeed);
    await step(`fund-${name}`, () => txs.submit(`fund-${name}`, {TransactionType:'Payment', Account:ISSUER_ADDRESS, Destination:holders[name].classicAddress, Amount:'10000000'}, issuerSigner));
  }
  const issuer = await MptIssuer.create(txs, issuerSigner, 'create-compliance-token');
  evidence['create-compliance-token'] = store.get<{receipt:unknown}>('tx:create-compliance-token')?.receipt;
  const id = issuer.issuanceId;
  const {A,B,C} = holders;
  const payment = (from: Wallet, to: string, value: string, key: string) => txs.submit(key, {TransactionType:'Payment',Account:from.classicAddress,Destination:to,Amount:{mpt_issuance_id:id,value}}, walletSigner(from));
  for (const name of ['A','B','C'] as const) {
    const holder = holders[name];
    const optin: SubmittableTransaction = {TransactionType:'MPTokenAuthorize',Account:holder.classicAddress,MPTokenIssuanceID:id};
    await step(`opt-in-${name}`, () => txs.submit(`opt-in-${name}`, optin, walletSigner(holder)));
  }
  await step('allowlist-rejects-unapproved', () => blocked('allowlist', () => payment(issuerWallet,A.classicAddress,'1','unapproved-payment'), ['tecNO_AUTH']));
  for (const name of ['A','B','C'] as const) await step(`approve-${name}`, () => issuer.approve(holders[name].classicAddress, `approve-${name}`));
  await step('mint-A', () => issuer.mint(A.classicAddress,'500','mint-A'));
  await step('mint-B', () => issuer.mint(B.classicAddress,'1000','mint-B'));
  await step('mint-C', () => issuer.mint(C.classicAddress,'200','mint-C'));
  await step('clawback-B-300', () => issuer.clawback(B.classicAddress,'300','clawback-B-300'));
  await step('freeze-A', () => issuer.freezeHolder(A.classicAddress,true,'freeze-A'));
  await step('A-cannot-send', () => blocked('A frozen send', () => payment(A,B.classicAddress,'1','A-frozen-send'), ['tecLOCKED']));
  await step('A-cannot-receive', () => blocked('A frozen receive', () => payment(B,A.classicAddress,'1','A-frozen-receive'), ['tecLOCKED']));
  // Explicitly exercise the protocol's redemption exception, then restore supply.
  await step('A-frozen-redemption-exception', () => payment(A,ISSUER_ADDRESS,'1','A-frozen-redeem'));
  await step('unfreeze-A', () => issuer.freezeHolder(A.classicAddress,false,'unfreeze-A'));
  await step('restore-A-redemption', () => issuer.mint(A.classicAddress,'1','restore-A-redemption'));
  await step('unfrozen-transfer-A-B', () => payment(A,B.classicAddress,'1','unfrozen-A-B'));
  await step('unfrozen-transfer-B-A', () => payment(B,A.classicAddress,'1','unfrozen-B-A'));
  await step('freeze-global', () => issuer.freezeAll(true,'freeze-global'));
  await step('global-blocks-transfer', () => blocked('global freeze', () => payment(A,B.classicAddress,'1','global-transfer'), ['tecLOCKED']));
  await step('global-redemption-exception', () => payment(A,ISSUER_ADDRESS,'1','global-redeem'));
  await step('unfreeze-global', () => issuer.freezeAll(false,'unfreeze-global'));
  await step('restore-global-redemption', () => issuer.mint(A.classicAddress,'1','restore-global-redemption'));
  await step('freeze-B-final', () => issuer.freezeHolder(B.classicAddress,true,'freeze-B-final'));
  await step('ban-C', () => issuer.ban(C.classicAddress));
  await step('banned-C-cannot-receive', () => blocked('ban', () => payment(A,C.classicAddress,'1','banned-C-receive'), ['tecNO_AUTH','tecLOCKED']));
  await step('ban-prevents-reapproval', async () => {
    await assert.rejects(issuer.approve(C.classicAddress,'invalid-reapprove'), /permanently banned/);
    await assert.rejects(issuer.freezeHolder(C.classicAddress,false,'invalid-unfreeze'), /permanently banned/);
    return true;
  });
  // Delete and recreate C's zero holding: holder opt-in must not restore issuer approval.
  await step('C-delete-holding', () => txs.submit('C-delete-holding',{TransactionType:'MPTokenAuthorize',Account:C.classicAddress,MPTokenIssuanceID:id,Flags:1},walletSigner(C)));
  await step('C-recreate-holding', () => txs.submit('C-recreate-holding',{TransactionType:'MPTokenAuthorize',Account:C.classicAddress,MPTokenIssuanceID:id},walletSigner(C)));
  await step('C-still-cannot-receive', () => blocked('recreated banned holding', () => payment(A,C.classicAddress,'1','C-recreated-receive'), ['tecNO_AUTH']));
  await step('issuer-cannot-pay-banned-C', () => blocked('issuer to banned holder', () => payment(issuerWallet,C.classicAddress,'1','issuer-banned-C'), ['tecNO_AUTH']));
  const result: DemoResult = {issuanceId:id,holders:{A:A.classicAddress,B:B.classicAddress,C:C.classicAddress}};
  const report = await verify(client,result);
  await writeFile('verification.json',JSON.stringify(report,null,2)+'\n');
  await writeFile('demo-evidence.json',JSON.stringify(evidence,null,2)+'\n');
  await writeFile('result.json.tmp',JSON.stringify(result,null,2)+'\n');
  await rename('result.json.tmp','result.json');
  console.log('Verified final testnet state; wrote result.json, verification.json and demo-evidence.json');
} finally { store.close(); await client.disconnect(); }
