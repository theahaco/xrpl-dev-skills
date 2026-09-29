/**
 * Exercises every compliance control of the MPT issuer module against XRPL Testnet:
 * allowlist, payments, per-holder freeze/unfreeze, clawback, ban, and global freeze/unfreeze.
 *
 * Usage: npm run demo
 */

import * as fs from 'fs';
import * as path from 'path';
import { Client, Wallet } from 'xrpl';
import { MptIssuer, optInToMpt } from './mptIssuer';

const TESTNET_WS = 'wss://s.altnet.rippletest.net:51233';

const ISSUER_ADDRESS = 'rsSpuaBNJYCDXgqBncPtCoGgi7umsxsWgA';
const ISSUER_SEED = '<TESTNET_SEED_REDACTED>';

function log(step: string, detail?: string): void {
  const suffix = detail ? ` ${detail}` : '';
  console.log(`[demo] ${step}${suffix}`);
}

async function onboardHolder(
  client: Client,
  issuer: MptIssuer,
  holder: Wallet,
  issuanceId: string,
  label: string,
): Promise<void> {
  await optInToMpt(client, holder, issuanceId);
  await issuer.approveHolder(holder, issuanceId);
  log(`${label} opted in and was approved`, holder.address);
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_WS);
  await client.connect();
  log('Connected to Testnet');

  const issuerWallet = Wallet.fromSeed(ISSUER_SEED);
  if (issuerWallet.address !== ISSUER_ADDRESS) {
    throw new Error(
      `Issuer seed resolves to ${issuerWallet.address}, expected ${ISSUER_ADDRESS}`,
    );
  }

  log('Funding holder accounts A, B, C from the Testnet faucet...');
  const [{ wallet: walletA }, { wallet: walletB }, { wallet: walletC }] = await Promise.all([
    client.fundWallet(),
    client.fundWallet(),
    client.fundWallet(),
  ]);
  log('Holder A', walletA.address);
  log('Holder B', walletB.address);
  log('Holder C', walletC.address);

  const issuer = new MptIssuer(client, issuerWallet);

  log('Creating MPT issuance (allowlist + freeze + clawback + transfer enabled)...');
  const issuanceId = await issuer.createIssuance({
    assetScale: 0,
    maximumAmount: '1000000000',
    metadata: {
      name: 'Regulated Demo Stablecoin',
      ticker: 'RDSC',
      icon: 'https://example.com/rdsc-icon.png',
      asset_class: 'rwa',
      issuer_name: 'Wyndham Tech Demo Issuer',
    },
  });
  log('Issuance created', issuanceId);

  log('Onboarding holders (opt-in + KYC approval)...');
  await onboardHolder(client, issuer, walletA, issuanceId, 'Holder A');
  await onboardHolder(client, issuer, walletB, issuanceId, 'Holder B');
  await onboardHolder(client, issuer, walletC, issuanceId, 'Holder C');

  log('Issuer sends initial balances...');
  await issuer.sendFromIssuer(walletA, issuanceId, '500');
  log('Sent 500 to Holder A');
  await issuer.sendFromIssuer(walletB, issuanceId, '1000');
  log('Sent 1000 to Holder B');
  await issuer.sendFromIssuer(walletC, issuanceId, '200');
  log('Sent 200 to Holder C');

  log('Per-holder freeze: freezing Holder A, then lifting it...');
  await issuer.freezeHolder(walletA, issuanceId);
  log('Holder A frozen');
  await issuer.unfreezeHolder(walletA, issuanceId);
  log('Holder A unfrozen');

  log('Clawback: clawing back 300 from Holder B...');
  await issuer.clawback(walletB, issuanceId, '300');
  log('Clawed back 300 from Holder B (700 remaining)');

  log('Freezing Holder B (left frozen at the end)...');
  await issuer.freezeHolder(walletB, issuanceId);
  log('Holder B frozen');

  log('Banning Holder C (clawback remaining balance, lock, revoke authorization)...');
  await issuer.banHolder(walletC, issuanceId);
  log('Holder C banned');

  log('Global freeze: locking the whole issuance, then lifting it...');
  await issuer.freezeGlobal(issuanceId);
  log('Issuance globally frozen');
  await issuer.unfreezeGlobal(issuanceId);
  log('Issuance globally unfrozen');

  log('Verifying final on-ledger state...');
  const issuanceState = await issuer.getIssuanceState(issuanceId);
  const stateA = await issuer.getHolderState(walletA, issuanceId);
  const stateB = await issuer.getHolderState(walletB, issuanceId);
  const stateC = await issuer.getHolderState(walletC, issuanceId);

  console.log('[demo] Issuance state:', issuanceState);
  console.log('[demo] Holder A state:', stateA);
  console.log('[demo] Holder B state:', stateB);
  console.log('[demo] Holder C state:', stateC);

  assertState('Holder A balance', stateA.balance, '500');
  assertState('Holder A locked', stateA.locked, false);
  assertState('Holder B balance', stateB.balance, '700');
  assertState('Holder B locked', stateB.locked, true);
  assertState('Holder C balance', stateC.balance, '0');
  assertState('Holder C locked', stateC.locked, true);
  assertState('Holder C authorized', stateC.authorized, false);
  assertState('Issuance globally locked', issuanceState.globallyLocked, false);

  const result = {
    issuanceId,
    holders: {
      A: walletA.address,
      B: walletB.address,
      C: walletC.address,
    },
  };
  const resultPath = path.join(__dirname, '..', 'result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  log('Wrote result.json', resultPath);

  await client.disconnect();
  log('Done.');
}

function assertState(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${label} = ${String(actual)}, expected ${String(expected)}`);
  }
  log(`Verified: ${label} = ${String(expected)}`);
}

main().catch((err) => {
  console.error('[demo] Failed:', err);
  process.exitCode = 1;
});
