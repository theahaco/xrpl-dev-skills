import assert from 'node:assert/strict';
import { Client, Wallet, MPTokenAuthorizeFlags, type SubmittableTransaction } from 'xrpl';
import { FileStore, atomicJson } from './store.js';
import { LedgerExecutor, TESTNET_URL, type Receipt, type Signer } from './ledger.js';
import { MptIssuer } from './issuer.js';
import { verifyFinal, type DemoResult } from './verification.js';

const seed = process.env.XRPL_ISSUER_SEED;
if (!seed) throw new Error('Set XRPL_ISSUER_SEED; secrets are never embedded in source');
const wallet = Wallet.fromSeed(seed);
assert.equal(wallet.address, process.env.XRPL_ISSUER_ADDRESS ?? 'rp6RHAeLoaj98n9QSHDCr3eAvWLPhEedDX');
const client = new Client(TESTNET_URL, { maxFeeXRP: '0.001', connectionTimeout: 15000, timeout: 20000 });
const store = await FileStore.open('.local/demo-state.json');
const executor = new LedgerExecutor(client, store);
try {
  await client.connect(); await executor.checkNetwork();
  await executor.reconcilePending();
  let seeds = await store.get<{ A: string; B: string; C: string }>('holderSeeds');
  if (!seeds) {
    seeds = { A: Wallet.generate().seed!, B: Wallet.generate().seed!, C: Wallet.generate().seed! };
    await store.set('holderSeeds', seeds);
  }
  const holders = { A: Wallet.fromSeed(seeds.A), B: Wallet.fromSeed(seeds.B), C: Wallet.fromSeed(seeds.C) };
  async function step(name: string, work: () => Promise<void>): Promise<void> {
    if (await store.get<boolean>(`step:${name}`)) return;
    await work(); await store.set(`step:${name}`, true);
  }
  async function tx(name: string, transaction: SubmittableTransaction, signer: Signer, expected = 'tesSUCCESS'): Promise<Receipt> {
    const receipt = await executor.execute(name, transaction, signer);
    assert.equal(receipt.code, expected, name);
    return receipt;
  }
  for (const name of ['A', 'B', 'C'] as const) {
    await step(`fund-${name}`, async () => {
      await tx(`fund-${name}`, { TransactionType: 'Payment', Account: wallet.address,
        Destination: holders[name].address, Amount: '5000000' }, wallet);
    });
  }
  let issuanceId = await store.get<string>('issuanceId');
  if (!issuanceId) {
    const created = await MptIssuer.create(executor, wallet, 'create-issuance');
    issuanceId = created.issuanceId; await store.set('issuanceId', issuanceId);
  }
  const issuer = new MptIssuer(executor, wallet, issuanceId);
  const result: DemoResult = { issuanceId, holders: { A: holders.A.address, B: holders.B.address, C: holders.C.address } };
  const payment = (from: Signer, to: string, value = '1'): SubmittableTransaction => ({
    TransactionType: 'Payment', Account: from.address, Destination: to,
    Amount: { mpt_issuance_id: issuer.issuanceId, value },
  });
  for (const name of ['A', 'B', 'C'] as const) {
    await step(`opt-in-${name}`, async () => {
      await tx(`opt-in-${name}`, { TransactionType: 'MPTokenAuthorize', Account: holders[name].address,
        MPTokenIssuanceID: issuer.issuanceId }, holders[name]);
    });
  }
  await step('unapproved-rejected', async () => {
    await tx('unapproved-rejected', payment(wallet, holders.C.address), wallet, 'tecNO_AUTH');
  });
  for (const name of ['A', 'B', 'C'] as const) {
    await step(`approve-${name}`, () => issuer.approve(holders[name].address, `approve-${name}`));
  }
  for (const [name, value] of [['A', '500'], ['B', '1000'], ['C', '200']] as const) {
    await step(`mint-${name}`, () => issuer.mint(holders[name].address, value, `mint-${name}`));
  }
  await step('clawback-B-300', async () => {
    await issuer.clawback(holders.B.address, '300', 'clawback-B-300');
    assert.equal((await issuer.state(holders.B.address)).balance, '700');
  });
  await step('freeze-A', () => issuer.freezeHolder(holders.A.address, true, 'freeze-A'));
  await step('frozen-A-outbound-rejected', async () => {
    await tx('frozen-A-outbound-rejected', payment(holders.A, holders.B.address), holders.A, 'tecLOCKED');
  });
  await step('frozen-A-inbound-rejected', async () => {
    await tx('frozen-A-inbound-rejected', payment(holders.B, holders.A.address), holders.B, 'tecLOCKED');
  });
  await step('frozen-mint-policy', async () => {
    await assert.rejects(issuer.mint(holders.A.address, '1', 'forbidden-frozen-mint'), /frozen/);
  });
  // Characterize the protocol exception explicitly; restore balances after unlocking.
  await step('frozen-redemption-exception', async () => {
    await tx('frozen-redemption-exception', payment(holders.A, wallet.address), holders.A);
  });
  await step('unfreeze-A', () => issuer.freezeHolder(holders.A.address, false, 'unfreeze-A'));
  await step('restore-A', () => issuer.mint(holders.A.address, '1', 'restore-A'));
  await step('unfrozen-A-transfer', async () => { await tx('unfrozen-A-transfer', payment(holders.A, holders.B.address), holders.A); });
  await step('return-A-transfer', async () => { await tx('return-A-transfer', payment(holders.B, holders.A.address), holders.B); });
  await step('freeze-global', () => issuer.freezeGlobal(true, 'freeze-global'));
  await step('global-outbound-rejected', async () => {
    await tx('global-outbound-rejected', payment(holders.A, holders.B.address), holders.A, 'tecLOCKED');
  });
  await step('global-inbound-rejected', async () => {
    await tx('global-inbound-rejected', payment(holders.B, holders.A.address), holders.B, 'tecLOCKED');
  });
  await step('global-mint-policy', async () => {
    await assert.rejects(issuer.mint(holders.A.address, '1', 'forbidden-global-mint'), /frozen/);
  });
  await step('global-redemption-exception', async () => {
    await tx('global-redemption-exception', payment(holders.A, wallet.address), holders.A);
  });
  await step('unfreeze-global', () => issuer.freezeGlobal(false, 'unfreeze-global'));
  await step('restore-A-global', () => issuer.mint(holders.A.address, '1', 'restore-A-global'));
  await step('global-unfrozen-transfer', async () => { await tx('global-unfrozen-transfer', payment(holders.A, holders.B.address), holders.A); });
  await step('global-return-transfer', async () => { await tx('global-return-transfer', payment(holders.B, holders.A.address), holders.B); });
  await step('freeze-B', () => issuer.freezeHolder(holders.B.address, true, 'freeze-B'));
  await step('ban-C', () => issuer.ban(holders.C.address, 'demo-compliance-case-C', 'ban-C'));
  await step('banned-policy', async () => {
    await assert.rejects(issuer.approve(holders.C.address, 'forbidden-reapprove'), /banned/);
    await assert.rejects(issuer.freezeHolder(holders.C.address, false, 'forbidden-unfreeze'), /banned/);
    await assert.rejects(issuer.mint(holders.C.address, '1', 'forbidden-ban-mint'), /banned/);
  });
  await step('banned-issuer-payment-rejected', async () => {
    await tx('banned-issuer-payment-rejected', payment(wallet, holders.C.address), wallet, 'tecNO_AUTH');
  });
  await step('banned-holder-payment-rejected', async () => {
    await tx('banned-holder-payment-rejected', payment(holders.A, holders.C.address), holders.A, 'tecNO_AUTH');
  });
  // An adversarial holder can delete/recreate their empty MPToken, but cannot reauthorize themselves.
  await step('C-delete-holding', async () => {
    await tx('C-delete-holding', { TransactionType: 'MPTokenAuthorize', Account: holders.C.address,
      MPTokenIssuanceID: issuer.issuanceId, Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize }, holders.C);
  });
  await step('C-recreate-holding', async () => {
    await tx('C-recreate-holding', { TransactionType: 'MPTokenAuthorize', Account: holders.C.address,
      MPTokenIssuanceID: issuer.issuanceId }, holders.C);
  });
  await step('C-recreation-still-blocked', async () => {
    await tx('C-recreation-still-blocked', payment(holders.A, holders.C.address), holders.A, 'tecNO_AUTH');
    await tx('C-recreation-issuer-still-blocked', payment(wallet, holders.C.address), wallet, 'tecNO_AUTH');
  });
  const snapshot = await verifyFinal(client, issuer, result);
  assert.equal((await issuer.banStatus(holders.C.address))?.status, 'complete');
  const names = [
    'create-issuance', 'unapproved-rejected', 'approve-A', 'approve-B', 'approve-C',
    'mint-A', 'mint-B', 'mint-C', 'clawback-B-300', 'freeze-A',
    'frozen-A-outbound-rejected', 'frozen-A-inbound-rejected', 'frozen-redemption-exception',
    'unfreeze-A', 'restore-A', 'unfrozen-A-transfer', 'return-A-transfer', 'freeze-global',
    'global-outbound-rejected', 'global-inbound-rejected', 'global-redemption-exception',
    'unfreeze-global', 'restore-A-global', 'global-unfrozen-transfer', 'global-return-transfer',
    'freeze-B', 'ban-C:revoke', 'ban-C:lock', 'ban-C:drain',
    'banned-issuer-payment-rejected', 'banned-holder-payment-rejected',
    'C-delete-holding', 'C-recreate-holding', 'C-recreation-still-blocked', 'C-recreation-issuer-still-blocked',
  ];
  const evidence = [];
  for (const name of names) {
    const journal = await store.get<{ receipt: Receipt }>(`tx:${name}`);
    assert.ok(journal?.receipt);
    evidence.push({ operation: name, hash: journal.receipt.hash, ledgerIndex: journal.receipt.ledgerIndex, code: journal.receipt.code });
  }
  await atomicJson('demo-evidence.json', { network: 'testnet', endpoint: TESTNET_URL, verifiedAt: new Date().toISOString(),
    snapshot, transactions: evidence,
    limitations: ['Native MPT locks permit redemption to issuer; not absolute no-movement freezes.',
      'Issuer payment exceptions are guarded by backend policy; protect issuer signing authority.',
      'Bans require persistent issuer policy to prevent future issuer reauthorization.'] });
  await atomicJson('result.json', result);
  console.log('Verified final ledger state; wrote result.json and demo-evidence.json');
} finally {
  await client.disconnect(); await store.close();
}
