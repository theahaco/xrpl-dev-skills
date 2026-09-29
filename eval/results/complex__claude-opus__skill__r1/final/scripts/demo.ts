/**
 * End-to-end demo of every compliance control against XRPL testnet.
 *
 *   ISSUER_SEED=... npm run demo
 *
 * Creates a new issuance from the issuer account plus three funded holder accounts,
 * exercises allowlist, clawback, per-holder freeze, global freeze and ban (asserting
 * that the ledger actually rejects what each control should block), verifies the
 * final ledger state and writes result.json.
 *
 * Holder seeds are saved to $DATA_DIR/holders.json (default .data/, git-ignored)
 * before any XRP is sent to them.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client, Wallet, xrpToDrops } from 'xrpl';

import {
  ComplianceError,
  JsonFileComplianceRegistry,
  MptIssuer,
  bigintReplacer,
  optIn,
  submitOrThrow,
  transfer,
  type AuditEvent,
  type MptAmount,
  type ValidatedTransaction,
} from '../src/index.js';
import { demoConfig, issuerWallet, loadEnv } from './lib/env.js';
import { checkFinalState, printChecks, type DemoResult } from './lib/expected-state.js';

const HOLDER_FUNDING_XRP = '5';

loadEnv();
const config = demoConfig();

let stepNo = 0;
const step = (title: string) => console.log(`\n[${++stepNo}] ${title}`);
const info = (msg: string) => console.log(`    ${msg}`);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  info(`ok: ${message}`);
}

async function main(): Promise<void> {
  const issuerKeys = issuerWallet();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const registry = await JsonFileComplianceRegistry.open(join(config.dataDir, 'compliance-registry.json'));
  const auditLog: AuditEvent[] = [];

  const client = new Client(config.url);
  await client.connect();
  try {
    console.log(`Network: ${config.url}`);
    console.log(`Issuer:  ${issuerKeys.classicAddress}`);

    // ------------------------------------------------------------------ setup
    step('Create issuance with allowlist, clawback, lock and transfer enabled');
    const { issuer } = await MptIssuer.createIssuance(
      client,
      issuerKeys,
      {
        assetScale: 0,
        metadata: {
          ticker: 'DUSD',
          name: 'Demo Regulated Stablecoin',
          desc: 'Testnet demonstration of a compliance-controlled MPT. Not a real asset.',
          icon: 'https://example.com/dusd.png',
          asset_class: 'rwa',
          asset_subclass: 'stablecoin',
          issuer_name: 'Testnet Demo Issuer',
        },
      },
      { registry, onAudit: (e) => void auditLog.push(e) },
    );
    const id = issuer.issuanceId;
    info(`issuance ID: ${id}`);

    step('Create and fund holder accounts A, B, C');
    const wallets = { A: Wallet.generate(), B: Wallet.generate(), C: Wallet.generate() };
    await writeFile(
      join(config.dataDir, 'holders.json'),
      JSON.stringify({ issuanceId: id, holders: Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])) }, null, 2) + '\n',
      { mode: 0o600 },
    );
    for (const [name, w] of Object.entries(wallets)) {
      await submitOrThrow(client, issuerKeys, { TransactionType: 'Payment', Account: issuerKeys.classicAddress, Destination: w.classicAddress, Amount: xrpToDrops(HOLDER_FUNDING_XRP) });
      info(`${name}: ${w.classicAddress} funded with ${HOLDER_FUNDING_XRP} XRP`);
    }
    const { A, B, C } = wallets;
    const holders: DemoResult['holders'] = { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress };

    step('Holders opt in to the token');
    for (const w of [A, B, C]) await optIn(client, w, id);
    for (const [name, w] of Object.entries(wallets)) {
      const s = await issuer.getHolderStatus(w.classicAddress);
      assert(s.exists && !s.authorized, `${name} opted in but is not yet authorized`);
    }

    // ------------------------------------------------------------------ allowlist
    step('Allowlist: approve B and C (KYC passed), issue to them');
    await issuer.authorizeHolder(holders.B);
    await issuer.authorizeHolder(holders.C);
    await issuer.issue(holders.B, 1000n);
    await issuer.issue(holders.C, 250n);
    assert((await issuer.getHolderStatus(holders.B)).balance === 1000n, 'B holds 1000');
    assert((await issuer.getHolderStatus(holders.C)).balance === 250n, 'C holds 250');

    step('Allowlist: A is not yet approved, so it cannot receive');
    await expectRejectedOnLedger(transfer(client, C, holders.A, id, 10n), 'C -> A (A not authorized)');
    await expectCompliance(issuer.issue(holders.A, 500n), 'issuer -> A (A not authorized)');

    step('Allowlist: approve A and issue 500');
    await issuer.authorizeHolder(holders.A);
    await issuer.issue(holders.A, 500n);
    assert((await issuer.getHolderStatus(holders.A)).balance === 500n, 'A holds 500');

    // ------------------------------------------------------------------ clawback
    step('Clawback: claw back 300 from B');
    await issuer.clawback(holders.B, 300n);
    assert((await issuer.getHolderStatus(holders.B)).balance === 700n, 'B holds 700');

    // ------------------------------------------------------------------ per-holder freeze
    step('Per-holder freeze: freeze A');
    await issuer.freezeHolder(holders.A);
    assert((await issuer.getHolderStatus(holders.A)).frozen, 'A is frozen on ledger');
    await expectRejectedOnLedger(transfer(client, A, holders.C, id, 10n), 'A -> C (A frozen, cannot send)');
    await expectRejectedOnLedger(transfer(client, C, holders.A, id, 10n), 'C -> A (A frozen, cannot receive)');
    await expectCompliance(issuer.issue(holders.A, 1n), 'issuer -> A (A frozen)');

    step('Per-holder freeze: unfreeze A');
    await issuer.unfreezeHolder(holders.A);
    assert(!(await issuer.getHolderStatus(holders.A)).frozen, 'A is no longer frozen');
    await roundTrip(client, id, A, C, 10n, 'A <-> C');

    // ------------------------------------------------------------------ global freeze
    step('Global freeze: freeze the whole token');
    await issuer.freezeGlobal();
    assert((await issuer.getIssuanceStatus()).globallyFrozen, 'issuance is globally frozen on ledger');
    await expectRejectedOnLedger(transfer(client, A, holders.C, id, 10n), 'A -> C (global freeze)');
    await expectRejectedOnLedger(transfer(client, B, holders.A, id, 10n), 'B -> A (global freeze)');
    // XRPL protocol behaviour: locks never block payments back to the issuer. Shown with C
    // (banned later) so A's and B's balances are untouched. See README "Freeze and redemption".
    const redemption = await transfer(client, C, issuerKeys.classicAddress, id, 1n);
    assert(redemption.resultCode === 'tesSUCCESS', `ledger still allows C -> issuer redemption during global freeze (${redemption.hash})`);
    await expectCompliance(issuer.issue(holders.A, 1n), 'issuer -> A (global freeze)');

    step('Global freeze: lift it');
    await issuer.unfreezeGlobal();
    assert(!(await issuer.getIssuanceStatus()).globallyFrozen, 'issuance is no longer globally frozen');
    await roundTrip(client, id, A, C, 10n, 'A <-> C');

    // ------------------------------------------------------------------ freeze B (final state)
    step('Per-holder freeze: freeze B (stays frozen)');
    await issuer.freezeHolder(holders.B);
    assert((await issuer.getHolderStatus(holders.B)).frozen, 'B is frozen on ledger');
    await expectRejectedOnLedger(transfer(client, B, holders.A, id, 10n), 'B -> A (B frozen)');

    // ------------------------------------------------------------------ ban
    step('Ban: ban C');
    const ban = await issuer.ban(holders.C, 'Demo: sanctions screening hit');
    info(`ban transactions: ${ban.transactions.map((t) => t.hash).join(', ')}`);
    assert(ban.clawedBack === 249n, 'ban clawed back all of C\'s remaining 249 tokens');
    const cStatus = await issuer.getHolderStatus(holders.C);
    assert(cStatus.balance === 0n, 'C holds 0');
    assert(!cStatus.authorized, 'C is removed from the allowlist on ledger');
    assert(await issuer.isBanned(holders.C), 'C is recorded in the ban registry');
    await expectRejectedOnLedger(transfer(client, A, holders.C, id, 10n), 'A -> C (C banned)');
    await expectCompliance(issuer.authorizeHolder(holders.C), 'issuer re-authorizes C');
    await expectCompliance(issuer.issue(holders.C, 1n), 'issuer -> C');
    await expectCompliance(issuer.unfreezeHolder(holders.C), 'issuer unfreezes C');

    step('Ban: C deletes and re-creates its holding to try to shed the ban');
    await submitOrThrow(client, C, { TransactionType: 'MPTokenAuthorize', Account: C.classicAddress, MPTokenIssuanceID: id, Flags: 1 /* tfMPTUnauthorize */ });
    assert(!(await issuer.getHolderStatus(holders.C)).exists, 'C\'s MPToken entry was deleted');
    await optIn(client, C, id);
    await expectRejectedOnLedger(transfer(client, A, holders.C, id, 10n), 'A -> C (fresh holding is still unauthorized)');
    await issuer.ban(holders.C, 'Demo: re-applied after holder re-created its holding');
    const cAgain = await issuer.getHolderStatus(holders.C);
    assert(cAgain.frozen && !cAgain.authorized && cAgain.balance === 0n, 're-applying the ban re-freezes the new holding');

    // ------------------------------------------------------------------ verify + result
    step('Verify final ledger state');
    const result: DemoResult = { issuanceId: id, holders };
    const ok = printChecks(await checkFinalState(client, issuerKeys.classicAddress, result, registry));
    if (!ok) throw new Error('Final state verification failed; result.json not written');

    await writeFile(config.resultPath, JSON.stringify(result, null, 2) + '\n');
    console.log(`\nWrote ${config.resultPath}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await writeFile(join(config.dataDir, 'audit-log.json'), JSON.stringify(auditLog, bigintReplacer, 2) + '\n');
    await client.disconnect();
  }
}

/** Asserts that a transfer was included in a validated ledger with a non-success result. */
async function expectRejectedOnLedger(pending: Promise<ValidatedTransaction>, label: string): Promise<void> {
  const r = await pending;
  assert(r.resultCode !== 'tesSUCCESS', `ledger rejected ${label}: ${r.resultCode} (${r.hash})`);
}

/** Asserts that the issuer module refused an operation for compliance reasons without submitting it. */
async function expectCompliance(pending: Promise<unknown>, label: string): Promise<void> {
  try {
    await pending;
  } catch (err) {
    assert(err instanceof ComplianceError, `module refused ${label}: ${(err as Error).message}`);
    return;
  }
  throw new Error(`Expected ${label} to be refused, but it succeeded`);
}

/** Proves transfers work again by sending an amount and sending it straight back. */
async function roundTrip(client: Client, id: string, x: Wallet, y: Wallet, amount: MptAmount, label: string): Promise<void> {
  const there = await transfer(client, x, y.classicAddress, id, amount);
  const back = await transfer(client, y, x.classicAddress, id, amount);
  assert(there.resultCode === 'tesSUCCESS' && back.resultCode === 'tesSUCCESS', `${label} round trip of ${amount} succeeds`);
}

main().catch((err) => {
  console.error('\nDEMO FAILED:', err);
  process.exitCode = 1;
});
