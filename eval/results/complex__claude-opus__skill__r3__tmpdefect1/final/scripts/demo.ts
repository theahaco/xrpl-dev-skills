/**
 * End-to-end demo of every compliance control against XRPL testnet.
 *
 *   XRPL_ISSUER_SEED=... npm run demo               # real run, writes result.json
 *   XRPL_ISSUER_SEED=... npm run demo -- --rehearsal # same flow with a throwaway issuer
 *
 * In rehearsal mode a fresh issuer account is funded from XRPL_ISSUER_SEED's
 * account, so the real account ends up with no extra issuances.
 */
import { writeFile } from 'node:fs/promises';
import { Client, Wallet, xrpToDrops } from 'xrpl';
import {
  holder,
  JsonFileBanStore,
  JsonLineLogger,
  MptIssuer,
  PolicyViolationError,
  submitAndConfirm,
  TransactionFailedError,
  type AuditLogger,
} from '../src/index.js';

const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233';
const HOLDER_FUNDING_XRP = '3';
const REHEARSAL_ISSUER_FUNDING_XRP = '3';

const rehearsal = process.argv.includes('--rehearsal');
const wsUrl = process.env.XRPL_WS_URL ?? TESTNET_URL;
const logger: AuditLogger = new JsonLineLogger(process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info');
const outputPrefix = rehearsal ? 'rehearsal-' : '';

let stepNo = 0;
function step(title: string): void {
  console.log(`\n=== ${++stepNo}. ${title}`);
}
function ok(message: string): void {
  console.log(`  ✔ ${message}`);
}
function note(message: string): void {
  console.log(`  ℹ ${message}`);
}
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  ok(message);
}

/** Expects the module to refuse the operation before anything is submitted. */
async function expectPolicyRefusal(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PolicyViolationError) {
      ok(`${what} refused by module: ${error.message}`);
      return;
    }
    throw error;
  }
  throw new Error(`${what} unexpectedly succeeded`);
}

/** Expects the ledger itself to reject a transaction with one of `codes`. */
async function expectLedgerRejection(what: string, codes: string[], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof TransactionFailedError && codes.includes(error.engineResult)) {
      ok(`${what} rejected by ledger: ${error.engineResult}${error.hash ? ` (${error.hash})` : ''}`);
      return;
    }
    throw error;
  }
  throw new Error(`${what} unexpectedly succeeded`);
}

async function main(): Promise<void> {
  const seed = process.env.XRPL_ISSUER_SEED;
  if (!seed) {
    throw new Error('Set XRPL_ISSUER_SEED (see .env.example)');
  }
  const funder = Wallet.fromSeed(seed);
  const expectedAddress = process.env.XRPL_ISSUER_ADDRESS;
  if (expectedAddress && expectedAddress !== funder.classicAddress) {
    throw new Error(`Seed derives ${funder.classicAddress}, expected XRPL_ISSUER_ADDRESS=${expectedAddress}`);
  }
  if (wsUrl.includes('xrplcluster.com') || wsUrl.includes('s1.ripple.com') || wsUrl.includes('s2.ripple.com')) {
    throw new Error('Refusing to run the demo against mainnet');
  }

  const client = new Client(wsUrl);
  await client.connect();
  try {
    await run(client, funder);
  } finally {
    await client.disconnect();
  }
}

async function run(client: Client, funder: Wallet): Promise<void> {
  const issuerWallet = rehearsal ? Wallet.generate() : funder;
  const A = Wallet.generate();
  const B = Wallet.generate();
  const C = Wallet.generate();

  // Persist generated keys before funding them so no funds are ever stranded.
  const walletsFile = `${outputPrefix}demo-wallets.json`;
  await writeFile(
    walletsFile,
    JSON.stringify(
      {
        network: wsUrl,
        issuer: rehearsal ? { address: issuerWallet.classicAddress, seed: issuerWallet.seed } : { address: issuerWallet.classicAddress },
        A: { address: A.classicAddress, seed: A.seed },
        B: { address: B.classicAddress, seed: B.seed },
        C: { address: C.classicAddress, seed: C.seed },
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );

  step(`Fund accounts from ${funder.classicAddress}${rehearsal ? ' (REHEARSAL: throwaway issuer)' : ''}`);
  const fund = async (label: string, address: string, xrp: string) => {
    const tx = await submitAndConfirm(
      client,
      funder,
      { TransactionType: 'Payment', Account: funder.classicAddress, Destination: address, Amount: xrpToDrops(xrp) },
      logger,
    );
    ok(`${label} ${address} funded with ${xrp} XRP (${tx.hash})`);
  };
  if (rehearsal) {
    await fund('Issuer', issuerWallet.classicAddress, REHEARSAL_ISSUER_FUNDING_XRP);
  }
  await fund('Holder A', A.classicAddress, HOLDER_FUNDING_XRP);
  await fund('Holder B', B.classicAddress, HOLDER_FUNDING_XRP);
  await fund('Holder C', C.classicAddress, HOLDER_FUNDING_XRP);

  step('Create the MPT issuance with all compliance controls');
  const banStore = new JsonFileBanStore(`.data/${outputPrefix}bans.json`);
  const { issuer, tx: createTx } = await MptIssuer.createIssuance(
    client,
    issuerWallet,
    {
      assetScale: 0,
      transferable: true,
      metadata: {
        ticker: 'RUSD',
        name: 'Regulated USD (testnet demo)',
        desc: 'Testnet demonstration of a regulated, allowlisted stablecoin-style MPT.',
        icon: 'https://example.com/rusd.png',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Demo Issuer',
      },
    },
    { banStore, logger },
  );
  const id = issuer.issuanceId;
  ok(`Issuance ${id} created (${createTx.hash})`);
  const issuance = await issuer.getIssuanceState();
  assert(
    issuance.capabilities.requireAuth && issuance.capabilities.canLock && issuance.capabilities.canClawback,
    'issuance has RequireAuth, CanLock and CanClawback',
  );
  assert(!issuance.capabilities.canEscrow, 'issuance does not allow escrow (keeps every balance within clawback reach)');

  const send = (from: Wallet, to: Wallet, amount: string) =>
    holder.transfer(client, from, to.classicAddress, id, amount, issuer.assetScale, logger);
  const balance = async (w: Wallet) => (await issuer.getHolderState(w.classicAddress)).balance;

  step('Holders opt in to the token');
  for (const [label, w] of [['A', A], ['B', B], ['C', C]] as const) {
    await holder.optIn(client, w, id, logger);
    ok(`${label} opted in`);
  }

  step('Allowlist: approve A and B after KYC, then issue');
  await issuer.authorizeHolder(A.classicAddress);
  await issuer.authorizeHolder(B.classicAddress);
  await issuer.issue(A.classicAddress, '500');
  await issuer.issue(B.classicAddress, '1000');
  assert((await balance(A)) === '500', 'A holds 500');
  assert((await balance(B)) === '1000', 'B holds 1000');

  step('Allowlist: C is opted in but not yet approved');
  await expectPolicyRefusal('Issuing to unapproved C', () => issuer.issue(C.classicAddress, '10'));
  await expectLedgerRejection('Transfer A -> unapproved C', ['tecNO_AUTH'], () => send(A, C, '10'));
  await expectLedgerRejection('Direct issuer payment to unapproved C (bypassing module)', ['tecNO_AUTH'], () =>
    rawIssuerPayment(client, issuerWallet, C.classicAddress, id, '10'),
  );
  await issuer.authorizeHolder(C.classicAddress);
  await issuer.issue(C.classicAddress, '250');
  assert((await balance(C)) === '250', 'C approved and holds 250');

  step('Clawback: recover 300 from B');
  await expectPolicyRefusal('Clawing back more than B holds', () => issuer.clawback(B.classicAddress, '1001'));
  await issuer.clawback(B.classicAddress, '300');
  assert((await balance(B)) === '700', 'B holds 700');

  step('Per-holder freeze: freeze A');
  await issuer.freezeHolder(A.classicAddress);
  assert((await issuer.getHolderState(A.classicAddress)).frozen, 'A is frozen');
  await expectLedgerRejection('Frozen A sending to B', ['tecLOCKED'], () => send(A, B, '10'));
  await expectLedgerRejection('B sending to frozen A', ['tecLOCKED'], () => send(B, A, '10'));
  await expectPolicyRefusal('Issuing to frozen A', () => issuer.issue(A.classicAddress, '1'));
  note('The ledger does not stop the ISSUER paying a frozen holder; the module check above is that control.');
  await issuer.unfreezeHolder(A.classicAddress);
  assert(!(await issuer.getHolderState(A.classicAddress)).frozen, 'A is unfrozen');
  await send(A, B, '10');
  await send(B, A, '10');
  ok('A and B can transact again (A -> B 10, B -> A 10)');

  step('Global freeze: freeze all movement of the token');
  await issuer.freezeAll();
  assert((await issuer.getIssuanceState()).globallyFrozen, 'token is globally frozen');
  await expectLedgerRejection('A sending to B during global freeze', ['tecLOCKED'], () => send(A, B, '10'));
  await expectLedgerRejection('B sending to A during global freeze', ['tecLOCKED'], () => send(B, A, '10'));
  await expectPolicyRefusal('Issuing during global freeze', () => issuer.issue(A.classicAddress, '1'));
  note('The ledger does not stop ISSUER payments during a global freeze; the module check above is that control.');
  await issuer.unfreezeAll();
  assert(!(await issuer.getIssuanceState()).globallyFrozen, 'global freeze lifted');
  await send(A, B, '10');
  await send(B, A, '10');
  ok('Transfers work again (A -> B 10, B -> A 10)');

  step('Ban C');
  const ban = await issuer.banHolder(C.classicAddress, 'Demo: sanctions screening match');
  ok(`C banned; clawed back ${ban.clawedBack}; txs ${ban.record.txHashes.join(', ')}`);
  const cState = await issuer.getHolderState(C.classicAddress);
  assert(cState.balance === '0', 'C holds 0');
  assert(!cState.authorized, 'C is removed from the on-ledger allowlist');
  assert(cState.frozen, 'C is frozen');
  await expectPolicyRefusal('Re-authorizing banned C', () => issuer.authorizeHolder(C.classicAddress));
  await expectPolicyRefusal('Issuing to banned C', () => issuer.issue(C.classicAddress, '1'));
  await expectPolicyRefusal('Unfreezing banned C', () => issuer.unfreezeHolder(C.classicAddress));
  await expectLedgerRejection('Transfer A -> banned C', ['tecNO_AUTH', 'tecLOCKED'], () => send(A, C, '10'));
  await expectLedgerRejection('Direct issuer payment to banned C (bypassing module)', ['tecNO_AUTH', 'tecLOCKED'], () =>
    rawIssuerPayment(client, issuerWallet, C.classicAddress, id, '1'),
  );

  step('Freeze B');
  await issuer.freezeHolder(B.classicAddress);

  step('Verify final ledger state');
  const final = await issuer.getIssuanceState();
  const [a, b, c] = await Promise.all([A, B, C].map((w) => issuer.getHolderState(w.classicAddress)));
  if (!a || !b || !c) throw new Error('unreachable');
  assert(final.issuer === issuerWallet.classicAddress, `issued by ${issuerWallet.classicAddress}`);
  assert(
    final.capabilities.requireAuth && final.capabilities.canLock && final.capabilities.canClawback,
    'all compliance controls available',
  );
  assert(!final.globallyFrozen, 'token is not globally frozen');
  assert(a.authorized && a.balance === '500' && !a.frozen, 'A: approved, holds 500, not frozen');
  assert(b.authorized && b.balance === '700' && b.frozen, 'B: approved, holds 700, frozen');
  assert(!c.authorized && c.balance === '0' && c.frozen && c.banned, 'C: banned, holds 0, de-authorized, frozen');
  assert(final.outstanding === '1200', 'outstanding supply is 1200');

  const result = {
    issuanceId: id,
    holders: { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress },
  };
  await writeFile(`${outputPrefix}result.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(`\nWrote ${outputPrefix}result.json:\n${JSON.stringify(result, null, 2)}`);
}

/** Issuer payment that skips the module's policy checks, to show the ledger enforces them too. */
function rawIssuerPayment(client: Client, issuerWallet: Wallet, destination: string, issuanceId: string, value: string) {
  return submitAndConfirm(
    client,
    issuerWallet,
    {
      TransactionType: 'Payment',
      Account: issuerWallet.classicAddress,
      Destination: destination,
      Amount: { mpt_issuance_id: issuanceId, value },
    },
    logger,
  );
}

main().catch((error: unknown) => {
  console.error('\nDEMO FAILED:', error);
  process.exitCode = 1;
});
