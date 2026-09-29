import { Client, Wallet, type SubmittableTransaction, xrpToDrops } from 'xrpl';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { MptIssuer, preflight } from './issuer.js';
import { TransactionRunner, TransactionFailure, type Signer } from './transactions.js';
import { readJson, saveJson } from './storage.js';
import { verify } from './verify-state.js';
const ISSUER = 'rsrPoacdWBwtfcTAxQ6C66d82bmaaTZuR3';
const seed = process.env.ISSUER_SEED;
if (!seed) throw new Error('Set ISSUER_SEED using your secret manager or environment');
const issuerWallet = Wallet.fromSeed(seed);
assert.equal(issuerWallet.classicAddress, ISSUER);
const client = new Client('wss://s.altnet.rippletest.net:51233', { maxFeeXRP: '0.01' });
const runner = new TransactionRunner(client, '.private/journal.json');
const progress = readJson<{ done: string[]; issuanceId?: string }>('.private/progress.json', { done: [] });
// Holder seeds are encrypted at rest; issuer seed is never persisted.
function wallets(): Record<'A' | 'B' | 'C', Wallet> {
  const path = '.private/holders.enc.json';
  if (!existsSync(path)) {
    const salt = randomBytes(16), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', scryptSync(seed!, salt, 32), iv);
    const plain = JSON.stringify(Object.fromEntries(['A', 'B', 'C'].map(n => [n, Wallet.generate().seed])));
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    saveJson(path, { salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') });
  }
  const enc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(seed!, Buffer.from(enc.salt!, 'hex'), 32), Buffer.from(enc.iv!, 'hex'));
  decipher.setAuthTag(Buffer.from(enc.tag!, 'hex'));
  const seeds = JSON.parse(Buffer.concat([decipher.update(Buffer.from(enc.data!, 'hex')), decipher.final()]).toString('utf8')) as Record<'A' | 'B' | 'C', string>;
  return { A: Wallet.fromSeed(seeds.A), B: Wallet.fromSeed(seeds.B), C: Wallet.fromSeed(seeds.C) };
}
async function step(key: string, fn: () => Promise<unknown>): Promise<void> {
  if (progress.done.includes(key)) return;
  await fn(); progress.done.push(key); saveJson('.private/progress.json', progress);
  console.log(`Verified: ${key}`);
}
async function send(key: string, tx: SubmittableTransaction, signer: Signer): Promise<unknown> {
  return runner.exclusive(() => runner.send(key, tx, signer));
}
try {
  await client.connect();
  const environment = await preflight(client); saveJson('evidence/preflight.json', environment);
  const reserve = environment.server.validated_ledger;
  if (!reserve || reserve.reserve_base_xrp + reserve.reserve_inc_xrp >= 5) throw new Error('Insufficient holder funding for reserves');
  const account = (await client.request({ command: 'account_info', account: ISSUER, ledger_index: 'validated' })).result.account_data;
  const budget = xrpToDrops(String(reserve.reserve_base_xrp + (account.OwnerCount + 1) * reserve.reserve_inc_xrp + 16));
  if (!progress.done.length && BigInt(account.Balance) < BigInt(budget)) throw new Error('Insufficient issuer funding');
  const w = wallets();
  for (const [n, wallet] of Object.entries(w)) await step(`fund-${n}`, () => send(`fund-${n}`, {
    TransactionType: 'Payment', Account: ISSUER, Destination: wallet.classicAddress, Amount: xrpToDrops('5'),
  }, issuerWallet));
  const token = progress.issuanceId ? new MptIssuer(runner, issuerWallet, progress.issuanceId) : await MptIssuer.create(runner, issuerWallet, 'create');
  progress.issuanceId = token.issuanceId; saveJson('.private/progress.json', progress);
  await token.assertConfiguration();
  const payment = (from: Wallet, to: string): SubmittableTransaction => ({
    TransactionType: 'Payment', Account: from.classicAddress, Destination: to,
    Amount: { mpt_issuance_id: token.issuanceId, value: '1' },
  });
  async function denied(key: string, from: Wallet, to: string, code: string): Promise<void> {
    await step(key, async () => {
      try { await send(key, payment(from, to), from); }
      catch (error) {
        if (!(error instanceof TransactionFailure) || error.receipt.code !== code) throw error;
        return;
      }
      throw new Error(`Compliance violation: ${key} succeeded`);
    });
  }
  for (const [n, wallet] of Object.entries(w)) await step(`opt-in-${n}`, () => send(`opt-in-${n}`, {
    TransactionType: 'MPTokenAuthorize', Account: wallet.classicAddress, MPTokenIssuanceID: token.issuanceId,
  }, wallet));
  await denied('unapproved-receive', issuerWallet, w.C.classicAddress, 'tecNO_AUTH');
  for (const [n, wallet] of Object.entries(w)) await step(`approve-${n}`, () => token.approve(wallet.classicAddress, `approve-${n}`));
  for (const [n, value] of [['A', '500'], ['B', '1000'], ['C', '100']] as const) await step(`issue-${n}`, () => token.issue(w[n].classicAddress, value, `issue-${n}`));
  await step('freeze-A', () => token.freezeHolder(w.A.classicAddress, true, 'freeze-A'));
  await denied('frozen-A-send', w.A, w.C.classicAddress, 'tecLOCKED');
  await denied('frozen-A-receive', w.C, w.A.classicAddress, 'tecLOCKED');
  await step('frozen-A-mint-exception', () => send('frozen-A-mint', payment(issuerWallet, w.A.classicAddress), issuerWallet));
  await step('clawback-A-mint-exception', () => token.clawback(w.A.classicAddress, '1', 'clawback-A-mint-exception'));
  await step('frozen-A-redemption-exception', () => send('frozen-A-redemption-exception', payment(w.A, ISSUER), w.A));
  await step('unfreeze-A', () => token.freezeHolder(w.A.classicAddress, false, 'unfreeze-A'));
  await step('restore-A', () => token.issue(w.A.classicAddress, '1', 'restore-A'));
  await step('A-transfer-after-unfreeze', () => send('A-transfer-after-unfreeze', payment(w.A, w.C.classicAddress), w.A));
  await step('C-return-to-A', () => send('C-return-to-A', payment(w.C, w.A.classicAddress), w.C));
  await step('clawback-B-300', () => token.clawback(w.B.classicAddress, '300', 'clawback-B-300'));
  await step('freeze-B', () => token.freezeHolder(w.B.classicAddress, true, 'freeze-B'));
  await denied('frozen-B-send', w.B, w.A.classicAddress, 'tecLOCKED');
  await denied('frozen-B-receive', w.A, w.B.classicAddress, 'tecLOCKED');
  await step('global-freeze', () => token.freezeGlobal(true, 'global-freeze'));
  await denied('global-block-send', w.A, w.C.classicAddress, 'tecLOCKED');
  await step('global-mint-exception', () => send('global-mint-exception', payment(issuerWallet, w.A.classicAddress), issuerWallet));
  await step('clawback-global-mint-exception', () => token.clawback(w.A.classicAddress, '1', 'clawback-global-mint-exception'));
  await step('global-redemption-exception', () => send('global-redemption-exception', payment(w.A, ISSUER), w.A));
  await step('ban-C', () => token.ban(w.C.classicAddress, 'Demo compliance ban after approval', 'ban-C'));
  await step('global-unfreeze', () => token.freezeGlobal(false, 'global-unfreeze'));
  await step('restore-A-after-global', () => token.issue(w.A.classicAddress, '1', 'restore-A-after-global'));
  await denied('banned-C-peer-receive', w.A, w.C.classicAddress, 'tecNO_AUTH');
  await denied('banned-C-mint', issuerWallet, w.C.classicAddress, 'tecNO_AUTH');
  await step('banned-C-delete', () => send('banned-C-delete', { TransactionType: 'MPTokenAuthorize', Account: w.C.classicAddress, MPTokenIssuanceID: token.issuanceId, Flags: 1 }, w.C));
  await step('banned-C-recreate', () => send('banned-C-recreate', { TransactionType: 'MPTokenAuthorize', Account: w.C.classicAddress, MPTokenIssuanceID: token.issuanceId }, w.C));
  await denied('banned-C-recreated-receive', w.A, w.C.classicAddress, 'tecNO_AUTH');
  await step('banned-C-reapproval-refused', async () => {
    await assert.rejects(token.approve(w.C.classicAddress, 'forbidden-approve-C'), /permanently banned/);
    await assert.rejects(token.freezeHolder(w.C.classicAddress, false, 'forbidden-unfreeze-C'), /permanently banned/);
  });
  const result = { issuanceId: token.issuanceId, holders: { A: w.A.classicAddress, B: w.B.classicAddress, C: w.C.classicAddress } };
  saveJson('evidence/final-state.json', await verify(client, result));
  const journal = readJson<{ entries: Record<string, { receipt?: unknown }> }>('.private/journal.json', { entries: {} });
  saveJson('evidence/transactions.json', Object.fromEntries(Object.entries(journal.entries).map(([key, entry]) => [key, entry.receipt])));
  saveJson('result.json', result);
  console.log('Final validated state verified; result.json written.');
} finally { await client.disconnect(); runner.close(); }
