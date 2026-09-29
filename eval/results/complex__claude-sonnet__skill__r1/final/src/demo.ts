import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client, Wallet } from 'xrpl';
import { MptIssuer } from './mptIssuer';
import { holderOptIn } from './holder';
import { MptTransactionError } from './errors';

const NETWORK = process.env.XRPL_NETWORK ?? 'wss://s.altnet.rippletest.net:51233';
const ISSUER_SEED = process.env.ISSUER_SEED;
if (!ISSUER_SEED) {
  throw new Error('ISSUER_SEED is not set. Copy .env.example to .env and fill it in.');
}

function log(section: string, message: string): void {
  console.log(`[${section}] ${message}`);
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (BigInt(actual) !== BigInt(expected)) {
    throw new Error(`Assertion failed: ${label} — expected ${expected}, got ${actual}`);
  }
  log('assert', `${label} = ${actual} (ok)`);
}

function assertBool(actual: boolean, expected: boolean, label: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${label} — expected ${expected}, got ${actual}`);
  }
  log('assert', `${label} = ${actual} (ok)`);
}

/** Awaits `action`, and fails the demo unless it rejects with an MptTransactionError — used to prove a compliance control actually blocks a transaction, not just that the flag got set. */
async function expectBlocked(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof MptTransactionError) {
      log('enforcement', `${label}: correctly blocked (${error.resultCode})`);
      return;
    }
    throw error;
  }
  throw new Error(`Expected "${label}" to be blocked, but it succeeded`);
}

async function main(): Promise<void> {
  const client = new Client(NETWORK, { maxFeeXRP: '2' });
  await client.connect();
  log('setup', `Connected to ${NETWORK}`);

  try {
    const issuerWallet = Wallet.fromSeed(ISSUER_SEED as string);
    log('setup', `Issuer address: ${issuerWallet.address}`);

    const issuer = new MptIssuer(client, issuerWallet);

    // ---- Create the issuance -------------------------------------------------
    const issuanceId = await issuer.createIssuance({
      assetScale: 0,
      metadata: {
        ticker: 'WYNDUS',
        name: 'Wyndham Regulated Test Token',
        desc: 'Demo stablecoin-style MPT with allowlist, clawback, ban, and freeze controls.',
        icon: 'https://example.com/wyndus-icon.png',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Wyndham Tech (testnet demo)',
      },
    });
    log('issuance', `Created MPTokenIssuance ${issuanceId}`);

    const createdState = await issuer.getIssuanceState(issuanceId);
    assertBool(createdState.requiresAuth, true, 'issuance.requiresAuth');
    assertBool(createdState.canClawback, true, 'issuance.canClawback');
    assertBool(createdState.canLock, true, 'issuance.canLock');

    // ---- Fund holder + control accounts on testnet ---------------------------
    log('setup', 'Funding holder accounts A, B, C (and control account D) from the faucet...');
    const [{ wallet: walletA }, { wallet: walletB }, { wallet: walletC }, { wallet: walletD }] = await Promise.all([
      client.fundWallet(),
      client.fundWallet(),
      client.fundWallet(),
      client.fundWallet(),
    ]);
    log('setup', `A=${walletA.address} B=${walletB.address} C=${walletC.address} D(unapproved, control)=${walletD.address}`);

    // ---- Allowlist: holders opt in, then the issuer approves A, B, C ---------
    for (const [label, wallet] of [
      ['A', walletA],
      ['B', walletB],
      ['C', walletC],
      ['D', walletD],
    ] as const) {
      await holderOptIn(client, wallet, issuanceId);
      log('allowlist', `${label} opted in (created MPToken object)`);
    }
    for (const [label, wallet] of [
      ['A', walletA],
      ['B', walletB],
      ['C', walletC],
    ] as const) {
      await issuer.approveHolder(issuanceId, wallet.address);
      log('allowlist', `${label} approved by issuer`);
    }

    // D opted in but was never approved — sending to D must fail.
    await expectBlocked('payment to unapproved holder D', () => issuer.sendTokens(issuanceId, walletD.address, '1'));

    // ---- Issue tokens ----------------------------------------------------------
    await issuer.sendTokens(issuanceId, walletA.address, '500');
    log('payment', 'Sent 500 to A');
    await issuer.sendTokens(issuanceId, walletB.address, '1000');
    log('payment', 'Sent 1000 to B');
    await issuer.sendTokens(issuanceId, walletC.address, '250');
    log('payment', 'Sent 250 to C');

    // ---- Per-holder freeze: freeze A, prove it's blocked, then unfreeze -------
    await issuer.freezeHolder(issuanceId, walletA.address);
    log('freeze', 'A frozen');
    assertBool((await issuer.getHolderState(issuanceId, walletA.address)).frozen, true, 'A.frozen (mid-freeze)');
    await expectBlocked('payment to frozen holder A', () => issuer.sendTokens(issuanceId, walletA.address, '10'));
    await issuer.unfreezeHolder(issuanceId, walletA.address);
    log('freeze', 'A unfrozen');

    // ---- Clawback: seize 300 from B, then freeze B and leave it frozen --------
    await issuer.clawback(issuanceId, walletB.address, '300');
    log('clawback', 'Clawed back 300 from B');
    await issuer.freezeHolder(issuanceId, walletB.address);
    log('freeze', 'B frozen (left frozen)');

    // ---- Ban: seize C's remaining balance and revoke their authorization ------
    await issuer.banHolder(issuanceId, walletC.address);
    log('ban', 'C banned (clawed back to zero, authorization revoked)');
    await expectBlocked('payment to banned holder C', () => issuer.sendTokens(issuanceId, walletC.address, '1'));

    // ---- Global freeze: halt all movement, prove it, then lift it -------------
    await issuer.globalFreeze(issuanceId);
    log('global-freeze', 'Token globally frozen');
    assertBool((await issuer.getIssuanceState(issuanceId)).globallyFrozen, true, 'issuance.globallyFrozen (mid-freeze)');
    await expectBlocked('payment while globally frozen', () => issuer.sendTokens(issuanceId, walletA.address, '10'));
    await issuer.globalUnfreeze(issuanceId);
    log('global-freeze', 'Global freeze lifted');

    // ---- Verify final ledger state matches the required end state -------------
    const [finalA, finalB, finalC, finalIssuance] = await Promise.all([
      issuer.getHolderState(issuanceId, walletA.address),
      issuer.getHolderState(issuanceId, walletB.address),
      issuer.getHolderState(issuanceId, walletC.address),
      issuer.getIssuanceState(issuanceId),
    ]);

    assertEqual(finalA.balance, '500', 'A.balance');
    assertBool(finalA.frozen, false, 'A.frozen');
    assertEqual(finalB.balance, '700', 'B.balance');
    assertBool(finalB.frozen, true, 'B.frozen');
    assertEqual(finalC.balance, '0', 'C.balance');
    assertBool(finalC.authorized, false, 'C.authorized');
    assertBool(finalIssuance.globallyFrozen, false, 'issuance.globallyFrozen');

    log('done', 'Final ledger state matches the required end state.');

    const result = {
      issuanceId,
      holders: {
        A: walletA.address,
        B: walletB.address,
        C: walletC.address,
      },
    };
    const resultPath = path.join(__dirname, '..', 'result.json');
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    log('done', `Wrote ${resultPath}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
