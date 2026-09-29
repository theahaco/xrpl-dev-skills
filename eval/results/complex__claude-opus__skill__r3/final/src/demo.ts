/**
 * End-to-end demo of every compliance control against XRPL testnet.
 *
 *   npm run demo
 *
 * Reads ISSUER_SEED (and optionally ISSUER_ADDRESS, XRPL_URL) from the
 * environment or from .env. Creates three fresh holder accounts funded from
 * the issuer, and writes their seeds to .secrets/holders.json (mode 0600).
 * Each run creates a NEW issuance and new holders. On success it writes result.json.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { Client, Wallet, xrpToDrops } from 'xrpl';
import {
  type AuditEvent,
  FileBanRegistry,
  HolderBannedError,
  HolderFrozenError,
  HolderNotAuthorizedError,
  HolderNotOptedInError,
  GlobalFreezeActiveError,
  MptHolder,
  MptIssuer,
  TransactionFailedError,
  TransactionSubmitter,
  IssuanceFlags,
  REQUIRED_ISSUANCE_FLAGS,
} from './index.js';

const TESTNET_NETWORK_ID = 1;
const HOLDER_FUNDING_XRP = '5'; // 1 XRP base reserve + 0.2 XRP per MPToken + fees, with headroom

if (existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233';
const seed = process.env.ISSUER_SEED;
if (!seed) throw new Error('ISSUER_SEED is not set (see .env.example)');
const issuerWallet = Wallet.fromSeed(seed);
if (process.env.ISSUER_ADDRESS && process.env.ISSUER_ADDRESS !== issuerWallet.classicAddress) {
  throw new Error(`ISSUER_SEED derives ${issuerWallet.classicAddress}, expected ISSUER_ADDRESS ${process.env.ISSUER_ADDRESS}`);
}

const step = (title: string) => console.log(`\n=== ${title}`);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Demo assertion failed: ${message}`);
  ok(message);
}

async function expectLedgerRejection(label: string, action: Promise<unknown>, code: string): Promise<void> {
  try {
    await action;
  } catch (error) {
    if (error instanceof TransactionFailedError && error.resultCode === code) {
      ok(`${label} → rejected by the ledger with ${code} (tx ${error.hash})`);
      return;
    }
    throw error;
  }
  throw new Error(`${label}: expected ledger rejection ${code}, but it succeeded`);
}

async function expectComplianceRejection(
  label: string,
  action: Promise<unknown>,
  errorClass: abstract new (...args: never[]) => Error,
): Promise<void> {
  try {
    await action;
  } catch (error) {
    if (error instanceof errorClass) {
      ok(`${label} → refused by issuer module (${errorClass.name})`);
      return;
    }
    throw error;
  }
  throw new Error(`${label}: expected ${errorClass.name}, but it succeeded`);
}

async function main(): Promise<void> {
  const client = new Client(url);
  await client.connect();
  try {
    step('Preflight');
    const info = await client.request({ command: 'server_info' });
    const networkId = (info.result.info as { network_id?: number }).network_id;
    check(networkId === TESTNET_NETWORK_ID, `connected to XRPL testnet (network_id ${networkId}) at ${url}`);
    const issuerXrp = await client.getXrpBalance(issuerWallet.classicAddress);
    check(issuerXrp >= 20, `issuer ${issuerWallet.classicAddress} has ${issuerXrp} XRP`);

    // ------------------------------------------------------------------ holders
    step('Create and fund holder accounts A, B, C');
    const holderWallets = { A: Wallet.generate(), B: Wallet.generate(), C: Wallet.generate() };
    await mkdir('.secrets', { recursive: true, mode: 0o700 });
    const secretsPath = `.secrets/holders-${Date.now()}.json`;
    await writeFile(
      secretsPath,
      `${JSON.stringify(Object.fromEntries(Object.entries(holderWallets).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])), null, 2)}\n`,
      { mode: 0o600 },
    );
    ok(`holder seeds saved to ${secretsPath}`);
    const funder = new TransactionSubmitter(client, issuerWallet);
    for (const [name, wallet] of Object.entries(holderWallets)) {
      const tx = await funder.submit({
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: wallet.classicAddress,
        Amount: xrpToDrops(HOLDER_FUNDING_XRP),
      });
      ok(`${name} = ${wallet.classicAddress} funded with ${HOLDER_FUNDING_XRP} XRP (tx ${tx.hash})`);
    }

    // ------------------------------------------------------------------ issuance
    step('Create MPT issuance with RequireAuth + CanLock + CanClawback + CanTransfer');
    await mkdir('data', { recursive: true });
    const auditLog = 'data/audit.jsonl';
    const audit = async (event: AuditEvent) => {
      await appendFile(auditLog, `${JSON.stringify(event)}\n`);
    };
    const issuer = await MptIssuer.createIssuance(
      client,
      issuerWallet,
      {
        assetScale: 0,
        maximumAmount: 1_000_000_000n,
        metadata: {
          ticker: 'WUSD',
          name: 'Wyndham Regulated USD (testnet demo)',
          desc: 'Testnet demonstration of a permissioned, compliance-controlled MPT.',
          icon: 'https://example.com/wusd.png',
          asset_class: 'rwa',
          asset_subclass: 'stablecoin',
          issuer_name: 'Wyndham (testnet)',
        },
      },
      { banRegistry: new FileBanRegistry('data/bans.json'), audit },
    );
    const issuance = await issuer.verifyIssuance();
    ok(`issuance ${issuer.issuanceId} (flags 0x${issuance.flags.toString(16)})`);
    ok(`audit events → ${auditLog}`);

    const A = new MptHolder(client, holderWallets.A, issuer.issuanceId);
    const B = new MptHolder(client, holderWallets.B, issuer.issuanceId);
    const C = new MptHolder(client, holderWallets.C, issuer.issuanceId);
    const kyc = (name: string) => ({ kycReference: `DEMO-KYC-${name}` });

    // ------------------------------------------------------------------ allowlist
    step('Allowlist');
    await expectComplianceRejection('issue to A before A opted in', issuer.issue(A.address, 500n), HolderNotOptedInError);
    for (const h of [A, B, C]) await h.optIn();
    ok('A, B, C submitted MPTokenAuthorize (opt-in)');
    await issuer.authorizeHolder(A.address, kyc('A'));
    await issuer.authorizeHolder(B.address, kyc('B'));
    ok('issuer approved A and B');
    await issuer.issue(A.address, 500n);
    await issuer.issue(B.address, 1000n);
    ok('issued 500 to A and 1000 to B');
    await expectComplianceRejection('issue to C (opted in, not yet approved)', issuer.issue(C.address, 1n), HolderNotAuthorizedError);
    await expectLedgerRejection('B → C (C not yet approved)', B.send(C.address, 1n), 'tecNO_AUTH');
    await issuer.authorizeHolder(C.address, kyc('C'));
    await issuer.issue(C.address, 250n);
    ok('issuer approved C and issued 250 to C');

    // ------------------------------------------------------------------ per-holder freeze
    step('Per-holder freeze (A)');
    await issuer.freezeHolder(A.address, { reason: 'demo: suspicious activity review' });
    check((await issuer.getHolder(A.address)).frozen, 'A is frozen on ledger');
    await expectLedgerRejection('A → B while A frozen (send)', A.send(B.address, 1n), 'tecLOCKED');
    await expectLedgerRejection('B → A while A frozen (receive)', B.send(A.address, 1n), 'tecLOCKED');
    await expectComplianceRejection('issue to A while A frozen', issuer.issue(A.address, 1n), HolderFrozenError);
    await issuer.unfreezeHolder(A.address, { reason: 'demo: review cleared' });
    check(!(await issuer.getHolder(A.address)).frozen, 'A is unfrozen on ledger');
    await A.send(B.address, 1n);
    await B.send(A.address, 1n);
    ok('A → B and B → A transfers succeed again after unfreeze');

    // ------------------------------------------------------------------ clawback
    step('Clawback (300 from B)');
    await issuer.clawback(B.address, 300n, { reason: 'demo: court order' });
    check((await issuer.getHolder(B.address)).balance === 700n, 'B holds 700 after clawback');

    // ------------------------------------------------------------------ global freeze
    step('Global freeze');
    await issuer.freezeAll({ reason: 'demo: incident response' });
    check((await issuer.getIssuance()).globallyFrozen, 'issuance is globally frozen on ledger');
    await expectLedgerRejection('A → B during global freeze', A.send(B.address, 1n), 'tecLOCKED');
    await expectLedgerRejection('C → A during global freeze', C.send(A.address, 1n), 'tecLOCKED');
    await expectComplianceRejection('issue to A during global freeze', issuer.issue(A.address, 1n), GlobalFreezeActiveError);
    await issuer.unfreezeAll({ reason: 'demo: incident resolved' });
    check(!(await issuer.getIssuance()).globallyFrozen, 'global freeze lifted');
    await A.send(B.address, 1n);
    await B.send(A.address, 1n);
    ok('transfers succeed again after global unfreeze');

    // ------------------------------------------------------------------ ban
    step('Ban C');
    const ban = await issuer.banHolder(C.address, { reason: 'demo: sanctions list match' });
    for (const t of ban.transactions) ok(`${t.action}${t.amount ? ` ${t.amount}` : ''} (tx ${t.txHash})`);
    check(ban.clawedBack === 250n, `clawed back C's entire balance (${ban.clawedBack})`);
    check(ban.finalState.balance === 0n && !ban.finalState.authorized, 'C holds 0 and is not authorized');
    await expectLedgerRejection('B → C after ban', B.send(C.address, 1n), 'tecNO_AUTH');
    await expectComplianceRejection('re-authorize C', issuer.authorizeHolder(C.address, kyc('C')), HolderBannedError);
    await expectComplianceRejection('issue to C', issuer.issue(C.address, 1n), HolderBannedError);
    await C.optOut();
    await C.optIn();
    ok('C deleted and re-created its MPToken entry (attempt to reset its status)');
    check(!(await C.state()).authorized, 'C is still unauthorized after re-creating its entry');
    await expectLedgerRejection('B → C after C re-created its entry', B.send(C.address, 1n), 'tecNO_AUTH');

    // ------------------------------------------------------------------ final state
    step('Leave B frozen');
    await issuer.freezeHolder(B.address, { reason: 'demo: final state' });

    step('Verify final ledger state');
    const fin = await issuer.verifyIssuance();
    check(fin.issuer === issuerWallet.classicAddress, `issued by ${fin.issuer}`);
    check((fin.flags & REQUIRED_ISSUANCE_FLAGS) === REQUIRED_ISSUANCE_FLAGS, 'RequireAuth, CanLock, CanClawback and CanTransfer all set');
    check((fin.flags & IssuanceFlags.lsfMPTLocked) === 0, 'not globally frozen');
    const [a, b, c] = await Promise.all([issuer.getHolder(A.address), issuer.getHolder(B.address), issuer.getHolder(C.address)]);
    check(a.authorized && !a.frozen && a.balance === 500n && !a.banned, 'A: approved, not frozen, holds 500');
    check(b.authorized && b.frozen && b.balance === 700n && !b.banned, 'B: approved, frozen, holds 700');
    check(c.banned && !c.authorized && c.balance === 0n, 'C: banned, not approved, holds 0');
    check(fin.outstandingAmount === 1200n, 'outstanding supply is 1200');

    const result = {
      issuanceId: issuer.issuanceId,
      holders: { A: A.address, B: B.address, C: C.address },
    };
    await writeFile('result.json', `${JSON.stringify(result, null, 2)}\n`);
    step('Done. Wrote result.json');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('\nDEMO FAILED:', error);
  process.exitCode = 1;
});
