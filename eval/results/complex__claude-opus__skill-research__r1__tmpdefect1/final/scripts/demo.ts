/**
 * End-to-end demo of every compliance control against XRPL testnet.
 *
 *   npm run demo
 *
 * Requires ISSUER_SEED in the environment or in .env. Creates a new MPT
 * issuance from the issuer account plus three new holder accounts (A, B, C)
 * funded from the issuer, exercises each control, verifies the final ledger
 * state and writes result.json.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client, type Payment, Wallet, xrpToDrops } from 'xrpl';

import {
  type AuditEvent,
  ComplianceError,
  type ComplianceErrorCode,
  JsonFileBanRegistry,
  MptHolder,
  MptIssuer,
  type SubmittedTransaction,
  TransactionSubmitter,
} from '../src/index.js';

const TESTNET_NETWORK_ID = 1;
const ROOT = join(import.meta.dirname, '..');
const STATE_DIR = join(ROOT, '.demo-state');
const EXPLORER = 'https://testnet.xrpl.org/transactions/';
/** XRP sent to each new holder: 1 XRP base reserve + 0.2 XRP for the MPToken + fees, with headroom. */
const HOLDER_FUNDING_XRP = 5;
/**
 * Whole-token amounts keep on-ledger balances equal to the amounts in this
 * demo. AssetScale is permanent: pick the production value (e.g. 2 or 6 for a
 * stablecoin) before issuing on mainnet.
 */
const ASSET_SCALE = 0;

if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

function step(title: string): void {
  console.log(`\n=== ${title}`);
}

function logTx(label: string, tx: SubmittedTransaction): void {
  console.log(`  ${label}: ${tx.resultCode} in ledger ${tx.ledgerIndex}  ${EXPLORER}${tx.hash}`);
}

async function expectRefused(label: string, code: ComplianceErrorCode, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ComplianceError && error.code === code) {
      console.log(`  ${label}: refused by module (${code})`);
      return;
    }
    throw error;
  }
  throw new Error(`${label}: expected the module to refuse with ${code}, but it succeeded`);
}

async function expectLedgerRejects(
  label: string,
  expected: string,
  action: () => Promise<SubmittedTransaction>,
): Promise<void> {
  const tx = await action();
  if (tx.resultCode !== expected) throw new Error(`${label}: expected ${expected}, got ${tx.resultCode} (${tx.hash})`);
  logTx(`${label} -> rejected by ledger`, tx);
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Final state check failed: ${message}`);
  console.log(`  ok: ${message}`);
}

async function main(): Promise<void> {
  const client = new Client(process.env['XRPL_WS_URL'] ?? 'wss://s.altnet.rippletest.net:51233');
  await client.connect();
  try {
    const info = await client.request({ command: 'server_info' });
    if (info.result.info.network_id !== TESTNET_NETWORK_ID) {
      throw new Error(`Refusing to run: connected to network ${info.result.info.network_id}, not testnet`);
    }

    const issuerWallet = Wallet.fromSeed(requireEnv('ISSUER_SEED'));
    console.log(`Issuer: ${issuerWallet.classicAddress}`);
    console.log(`Issuer XRP balance: ${await client.getXrpBalance(issuerWallet.classicAddress)}`);

    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    const auditLog = join(STATE_DIR, 'audit.jsonl');
    const deps = {
      banRegistry: new JsonFileBanRegistry(join(STATE_DIR, 'bans.json')),
      audit: async (event: AuditEvent) => {
        await appendFile(auditLog, `${JSON.stringify(event)}\n`);
      },
    };

    // ------------------------------------------------------------------
    step('1. Create the MPT issuance with all compliance controls');
    const issuer = await MptIssuer.createIssuance(
      client,
      issuerWallet,
      {
        assetScale: ASSET_SCALE,
        metadata: {
          ticker: 'RUSD',
          name: 'Regulated USD (testnet demo)',
          desc: 'Issuer-controlled stablecoin-style MPT with allowlist, clawback, bans and freezes.',
          icon: 'https://example.com/rusd.png',
          asset_class: 'rwa',
          asset_subclass: 'stablecoin',
          issuer_name: 'Demo Issuer',
        },
      },
      deps,
    );
    const issuanceId = issuer.issuanceId;
    const issuance = await issuer.getIssuance();
    console.log(`  Issuance ID: ${issuanceId}`);
    console.log(
      `  Flags: canLock=${issuance.canLock} requireAuth=${issuance.requireAuth} ` +
        `canClawback=${issuance.canClawback} canTransfer=${issuance.canTransfer}`,
    );

    // Raw issuer submitter for XRP funding, and to prove the ledger enforces controls
    // even when this module's own checks are bypassed. The demo is sequential,
    // so it never races the module's submitter on the issuer's Sequence.
    const rawIssuer = new TransactionSubmitter(client, issuerWallet);
    const rawIssue = (destination: string, value: string) =>
      rawIssuer.submitExpectingFailure<Payment>({
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: destination,
        Amount: { mpt_issuance_id: issuanceId, value },
      });

    // ------------------------------------------------------------------
    step('2. Create and fund holder accounts A, B, C; each opts in');
    const wallets = { A: Wallet.generate(), B: Wallet.generate(), C: Wallet.generate() };
    await writeFile(
      join(STATE_DIR, `holders-${issuanceId}.json`),
      `${JSON.stringify(
        Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])),
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const holders = {} as Record<keyof typeof wallets, MptHolder>;
    for (const [name, wallet] of Object.entries(wallets) as [keyof typeof wallets, Wallet][]) {
      const funded = await rawIssuer.submit<Payment>({
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: wallet.classicAddress,
        Amount: xrpToDrops(HOLDER_FUNDING_XRP),
      });
      logTx(`fund ${name} ${wallet.classicAddress} with ${HOLDER_FUNDING_XRP} XRP`, funded);
      holders[name] = new MptHolder(client, wallet, issuanceId, issuer.assetScale);
      logTx(`${name} opts in`, await holders[name].optIn());
    }
    const { A, B, C } = holders;

    // ------------------------------------------------------------------
    step('3. Allowlist: nobody can receive the token before approval');
    await expectRefused('issue 500 to A before approval', 'HOLDER_NOT_AUTHORIZED', () => issuer.issue(A.address, '500'));
    await expectLedgerRejects('raw issuer payment to unapproved A', 'tecNO_AUTH', () => rawIssue(A.address, '1'));
    for (const [name, holder] of Object.entries(holders)) {
      const result = await issuer.authorizeHolder(holder.address);
      if (result.tx) logTx(`approve ${name} (post-KYC)`, result.tx);
    }

    step('4. Issue tokens: A 500, B 1000, C 100');
    logTx('issue 500 to A', await issuer.issue(A.address, '500'));
    logTx('issue 1000 to B', await issuer.issue(B.address, '1000'));
    logTx('issue 100 to C', await issuer.issue(C.address, '100'));

    // ------------------------------------------------------------------
    step('5. Per-holder freeze: freeze A, prove A cannot send or receive, unfreeze');
    logTx('freeze A', (await issuer.freezeHolder(A.address)).tx!);
    await expectLedgerRejects('A sends 10 to B while A frozen', 'tecLOCKED', () => A.sendExpectingFailure(B.address, '10'));
    await expectLedgerRejects('B sends 10 to A while A frozen', 'tecLOCKED', () => B.sendExpectingFailure(A.address, '10'));
    await expectRefused('issue 10 to frozen A', 'HOLDER_FROZEN', () => issuer.issue(A.address, '10'));
    logTx('unfreeze A', (await issuer.unfreezeHolder(A.address)).tx!);
    logTx('A sends 50 to B after unfreeze', await A.send(B.address, '50'));
    logTx('B returns 50 to A', await B.send(A.address, '50'));

    // ------------------------------------------------------------------
    step('6. Clawback: claw back 300 from B');
    const clawed = await issuer.clawback(B.address, '300');
    logTx(`claw back ${clawed.clawedBack} from B`, clawed.tx);
    if (clawed.clawedBack !== '300') throw new Error(`Expected to claw back 300, clawed back ${clawed.clawedBack}`);

    // ------------------------------------------------------------------
    step('7. Global freeze: freeze all movement, prove it, lift it');
    logTx('global freeze', (await issuer.freezeAll()).tx!);
    await expectLedgerRejects('A sends 10 to B during global freeze', 'tecLOCKED', () => A.sendExpectingFailure(B.address, '10'));
    await expectLedgerRejects('C sends 10 to A during global freeze', 'tecLOCKED', () => C.sendExpectingFailure(A.address, '10'));
    await expectRefused('issue 10 to A during global freeze', 'GLOBALLY_FROZEN', () => issuer.issue(A.address, '10'));
    logTx('lift global freeze', (await issuer.unfreezeAll()).tx!);
    logTx('C sends 10 to A after global unfreeze', await C.send(A.address, '10'));
    logTx('A returns 10 to C', await A.send(C.address, '10'));

    // ------------------------------------------------------------------
    step('8. Ban C');
    const ban = await issuer.banHolder(C.address, 'Demo: sanctions screening hit');
    for (const tx of ban.transactions) logTx(`ban C: ${tx.transactionType}`, tx);
    console.log(`  clawed back ${ban.clawedBack} from C as part of the ban`);
    await expectRefused('re-approve banned C', 'HOLDER_BANNED', () => issuer.authorizeHolder(C.address));
    await expectRefused('issue to banned C', 'HOLDER_BANNED', () => issuer.issue(C.address, '1'));
    await expectLedgerRejects('raw issuer payment to banned C', 'tecNO_AUTH', () => rawIssue(C.address, '1'));
    await expectLedgerRejects('A sends 10 to banned C', 'tecNO_AUTH', () => A.sendExpectingFailure(C.address, '10'));

    // ------------------------------------------------------------------
    step('9. Freeze B (left frozen)');
    logTx('freeze B', (await issuer.freezeHolder(B.address)).tx!);

    // ------------------------------------------------------------------
    step('10. Verify final ledger state');
    const final = await issuer.getIssuance();
    const [a, b, c] = await Promise.all([A, B, C].map((h) => issuer.getHolder(h.address)));
    if (!a || !b || !c) throw new Error('unreachable');
    check(final.issuer === issuerWallet.classicAddress, `issuance ${issuanceId} is issued by ${final.issuer}`);
    check(final.canLock && final.requireAuth && final.canClawback, 'Can Lock, Require Auth and Can Clawback are enabled');
    check(!final.globallyFrozen, 'token is not globally frozen');
    check(a.authorized && !a.frozen && !a.banned && a.balance === '500', `A approved, not frozen, holds ${a.balance}`);
    check(b.authorized && b.frozen && !b.banned && b.balance === '700', `B approved, frozen, holds ${b.balance}`);
    check(c.banned && !c.authorized && c.frozen && c.balance === '0', `C banned, unauthorized, frozen, holds ${c.balance}`);
    check(await issuer.isBanEnforced(C.address), 'ban on C is fully enforced');
    check(final.outstandingBaseUnits === 1_200n, `outstanding supply is ${final.outstandingBaseUnits}`);

    const result = {
      issuanceId,
      holders: { A: A.address, B: B.address, C: C.address },
    };
    await writeFile(join(ROOT, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nWrote result.json:\n${JSON.stringify(result, null, 2)}`);
    console.log(`Audit trail: ${auditLog}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
