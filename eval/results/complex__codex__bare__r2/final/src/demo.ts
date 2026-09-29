import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { Wallet, type Payment } from 'xrpl';
import { TestnetLedger, LedgerFailure } from './ledger.js';
import { MptIssuer } from './issuer.js';
import { FileBanStore, readJson, writeJson } from './storage.js';
import { verify, type DemoResult } from './verify.js';

const seed = process.env.XRPL_ISSUER_SEED;
if (!seed) throw new Error('Set XRPL_ISSUER_SEED (testnet only)');
const wallet = Wallet.fromSeed(seed);
assert.equal(wallet.classicAddress, 'rnALUjoU7amSCUJkk18CxbfFhsQ9JtcJ3u', 'Unexpected issuer');
const ledger = await TestnetLedger.open(wallet, '.private/journal');
try {
  if (existsSync('result.json')) {
    await verify(ledger.client, readJson('result.json') as DemoResult);
    process.exitCode = 0;
  } else {
    const stepPath = '.private/steps.json';
    const done = new Set(existsSync(stepPath) ? readJson(stepPath) as string[] : []);
    const step = async (key: string, action: () => Promise<unknown>): Promise<void> => {
      if (done.has(key)) return;
      await action(); done.add(key); writeJson(stepPath, [...done]);
    };
    const path = '.private/holders.json';
    if (!existsSync(path)) writeJson(path, Object.fromEntries(['A', 'B', 'C'].map(name => [name, Wallet.generate().seed])));
    const secrets = readJson(path) as Record<'A' | 'B' | 'C', string>;
    const holders = { A: Wallet.fromSeed(secrets.A), B: Wallet.fromSeed(secrets.B), C: Wallet.fromSeed(secrets.C) };
    const issuer = await MptIssuer.create(wallet.classicAddress, ledger, new FileBanStore('.private/bans.json'), 'create');
    const id = issuer.issuanceId;
    const result: DemoResult = { issuanceId: id, holders: { A: holders.A.classicAddress, B: holders.B.classicAddress, C: holders.C.classicAddress } };
    writeJson('.private/result-draft.json', result);
    const payment = (from: Wallet, to: string, value: string): Payment => ({ TransactionType: 'Payment', Account: from.classicAddress, Destination: to, Amount: { mpt_issuance_id: id, value } });
    const blocked = async (key: string, from: Wallet, to: string, codes: string[]) => {
      try { await ledger.sendAs(key, payment(from, to, '1'), from); }
      catch (error) {
        if (error instanceof LedgerFailure && codes.includes(error.receipt.code)) return;
        throw error;
      }
      throw new Error(`Compliance failure: prohibited payment ${key} succeeded`);
    };
    for (const [name, holder] of Object.entries(holders)) {
      await step(`fund-${name}`, () => ledger.send(`fund-${name}`, { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: holder.classicAddress, Amount: '5000000' }));
      await step(`opt-in-${name}`, () => ledger.sendAs(`opt-in-${name}`, { TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress, MPTokenIssuanceID: id }, holder));
      await blocked(`unapproved-${name}`, wallet, holder.classicAddress, ['tecNO_AUTH']);
      await step(`approve-${name}`, () => issuer.approve(holder.classicAddress, `approve-${name}`));
    }
    await step('mint-A', () => issuer.mint(holders.A.classicAddress, '500', 'mint-A'));
    await step('mint-B', () => issuer.mint(holders.B.classicAddress, '1000', 'mint-B'));
    await step('mint-C', () => issuer.mint(holders.C.classicAddress, '200', 'mint-C'));
    await step('freeze-A', () => issuer.freeze(holders.A.classicAddress, 'freeze-A'));
    await blocked('frozen-A-send', holders.A, holders.C.classicAddress, ['tecLOCKED']);
    await blocked('frozen-A-receive', holders.C, holders.A.classicAddress, ['tecLOCKED']);
    // Demonstrate the native freeze exception: holder can still redeem to issuer.
    await step('frozen-A-redemption', () => ledger.sendAs('frozen-A-redemption', payment(holders.A, wallet.classicAddress, '1'), holders.A));
    await step('unfreeze-A', () => issuer.unfreeze(holders.A.classicAddress, 'unfreeze-A'));
    await step('restore-A', () => issuer.mint(holders.A.classicAddress, '1', 'restore-A'));
    await step('unfrozen-A-send', () => ledger.sendAs('unfrozen-A-send', payment(holders.A, holders.C.classicAddress, '1'), holders.A));
    await step('unfrozen-A-receive', () => ledger.sendAs('unfrozen-A-receive', payment(holders.C, holders.A.classicAddress, '1'), holders.C));
    await step('clawback-B', () => issuer.clawback(holders.B.classicAddress, '300', 'clawback-B'));
    await step('freeze-B', () => issuer.freeze(holders.B.classicAddress, 'freeze-B'));
    await blocked('frozen-B-send', holders.B, holders.A.classicAddress, ['tecLOCKED']);
    await blocked('frozen-B-receive', holders.A, holders.B.classicAddress, ['tecLOCKED']);
    await step('freeze-global', () => issuer.globalFreeze('freeze-global'));
    await blocked('global-send', holders.A, holders.C.classicAddress, ['tecLOCKED']);
    await step('unfreeze-global', () => issuer.globalUnfreeze('unfreeze-global'));
    await step('global-unfrozen-send', () => ledger.sendAs('global-unfrozen-send', payment(holders.A, holders.C.classicAddress, '1'), holders.A));
    await step('global-unfrozen-return', () => ledger.sendAs('global-unfrozen-return', payment(holders.C, holders.A.classicAddress, '1'), holders.C));
    await step('ban-C', () => issuer.ban(holders.C.classicAddress, 'ban-C'));
    await blocked('banned-C-peer-receive', holders.A, holders.C.classicAddress, ['tecNO_AUTH']);
    await blocked('banned-C-issuer-receive', wallet, holders.C.classicAddress, ['tecNO_AUTH']);
    await assert.rejects(issuer.approve(holders.C.classicAddress, 'banned-reapproval'), /banned/);
    // Holder deletes and recreates its entry; approval must not survive that cycle.
    await step('C-delete-entry', () => ledger.sendAs('C-delete-entry', { TransactionType: 'MPTokenAuthorize', Account: holders.C.classicAddress, MPTokenIssuanceID: id, Flags: 1 }, holders.C));
    await step('C-recreate-entry', () => ledger.sendAs('C-recreate-entry', { TransactionType: 'MPTokenAuthorize', Account: holders.C.classicAddress, MPTokenIssuanceID: id }, holders.C));
    await blocked('banned-C-after-recreate', holders.A, holders.C.classicAddress, ['tecNO_AUTH']);
    await verify(ledger.client, result);
    const receipts = readdirSync('.private/journal').filter(f => f.endsWith('.json')).map(f => {
      const entry = readJson(`.private/journal/${f}`) as { intent: string; receipt: unknown };
      return { transaction: JSON.parse(entry.intent) as unknown, receipt: entry.receipt };
    });
    writeJson('audit.json', receipts);
    writeJson('result.json', result);
    console.log('Wrote result.json and verification.json');
  }
} finally { await ledger.close(); }
