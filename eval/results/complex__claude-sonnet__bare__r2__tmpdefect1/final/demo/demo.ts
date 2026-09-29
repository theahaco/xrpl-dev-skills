/**
 * End-to-end demo of the MptIssuer compliance controls against XRP Ledger
 * testnet: issues a regulated MPT, allowlists three holders, then walks
 * through every control (allowlist, freeze/unfreeze, clawback, ban, global
 * freeze/unfreeze), asserting along the way that blocked actions are
 * actually rejected on-ledger rather than just trusting the happy path.
 *
 * Usage: npm run demo
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client, Wallet } from 'xrpl';
import type { Payment } from 'xrpl';
import { MptIssuer, MptIssuerError, optInHolder } from '../src/issuer';

const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233';
const ISSUER_SEED = '<TESTNET_SEED_REDACTED>';
const HOLDER_FUNDING_XRP = '20';

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

/**
 * Runs `action` and asserts that it fails as an `MptIssuerError` (i.e. the
 * transaction was rejected on-ledger). If it does not fail, a compliance
 * control silently did not do its job, which is treated as fatal.
 */
async function expectRejected(description: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof MptIssuerError) {
      log(`  [ok] ${description} was correctly rejected on-ledger (${error.engineResult ?? 'unknown result'})`);
      return;
    }
    throw error;
  }
  throw new Error(`Compliance control failure: expected "${description}" to be rejected, but it succeeded`);
}

/**
 * Submits an MPT payment signed by a holder (rather than the issuer), to
 * verify holder-initiated behavior such as the global freeze blocking
 * peer transfers. Not part of the reusable issuer module, since the
 * issuer backend never signs on a holder's behalf.
 */
async function payAsHolder(
  client: Client,
  fromWallet: Wallet,
  toAddress: string,
  issuanceId: string,
  amount: string,
): Promise<void> {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: fromWallet.address,
    Destination: toAddress,
    Amount: { mpt_issuance_id: issuanceId, value: amount },
  };
  const response = await client.submitAndWait(tx, { wallet: fromWallet });
  const meta = response.result.meta;
  const engineResult = meta && typeof meta === 'object' ? meta.TransactionResult : undefined;
  if (engineResult !== 'tesSUCCESS') {
    throw new MptIssuerError('Payment', engineResult, `Holder payment failed with result ${engineResult ?? '(no metadata returned)'}`);
  }
}

async function fundHolder(client: Client, issuerWallet: Wallet, holderWallet: Wallet): Promise<void> {
  const response = await client.submitAndWait(
    {
      TransactionType: 'Payment',
      Account: issuerWallet.address,
      Destination: holderWallet.address,
      Amount: String(Number(HOLDER_FUNDING_XRP) * 1_000_000),
    },
    { wallet: issuerWallet },
  );
  const result = response.result.meta && typeof response.result.meta === 'object' ? response.result.meta.TransactionResult : undefined;
  if (result !== 'tesSUCCESS') {
    throw new Error(`Failed to fund holder ${holderWallet.address}: ${result ?? 'unknown result'}`);
  }
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_URL);
  await client.connect();
  log(`Connected to ${TESTNET_URL}`);

  try {
    const issuerWallet = Wallet.fromSeed(ISSUER_SEED);
    log(`Issuer account: ${issuerWallet.address}`);

    const holderA = Wallet.generate();
    const holderB = Wallet.generate();
    const holderC = Wallet.generate();
    log(`Generated holder A: ${holderA.address}`);
    log(`Generated holder B: ${holderB.address}`);
    log(`Generated holder C: ${holderC.address}`);

    log(`\nFunding holders with ${HOLDER_FUNDING_XRP} XRP each from the issuer account...`);
    for (const holder of [holderA, holderB, holderC]) {
      await fundHolder(client, issuerWallet, holder);
    }
    log('  [ok] all holders funded and activated');

    const issuer = new MptIssuer(client, issuerWallet);

    log('\nCreating MPT issuance (lockable, clawback-able, requires authorization, transferable)...');
    const issuanceId = await issuer.createIssuance({
      assetScale: 0,
      metadata: {
        ticker: 'RUSD',
        name: 'Regulated USD',
        desc: 'Demo regulated, stablecoin-style token issued on XRPL testnet',
        icon: 'https://example.com/icon.png',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Wyndham Tech Demo Issuer',
      },
    });
    log(`  [ok] issuance created: ${issuanceId}`);

    log('\nOnboarding holders (holder opts in, then issuer allowlists them)...');
    for (const [label, holder] of [
      ['A', holderA],
      ['B', holderB],
      ['C', holderC],
    ] as const) {
      await optInHolder(client, holder, issuanceId);
      await issuer.approveHolder(holder.address);
      log(`  [ok] holder ${label} (${holder.address}) opted in and allowlisted`);
    }

    log('\n--- Holder A: freeze then unfreeze ---');
    await issuer.pay(holderA.address, '500');
    log('  [ok] paid A 500');
    await issuer.freezeHolder(holderA.address);
    log('  [ok] froze A');
    await expectRejected('a payment to frozen holder A', () => issuer.pay(holderA.address, '1'));
    await issuer.unfreezeHolder(holderA.address);
    log('  [ok] unfroze A');

    log('\n--- Global freeze then unfreeze ---');
    // Test this while A and B are both active, unfrozen, allowlisted
    // holders, so a rejection can only be explained by the global lock
    // (isolated from the per-holder freeze/ban controls exercised elsewhere).
    await issuer.globalFreeze();
    log('  [ok] globally froze the issuance');
    // The global lock blocks holder-initiated transfers; the issuer itself
    // (the party invoking the freeze) can still act, e.g. to run clawback
    // during an incident, so the meaningful check is a holder-to-holder transfer.
    await expectRejected('a holder-to-holder transfer while globally frozen', () =>
      payAsHolder(client, holderA, holderB.address, issuanceId, '1'),
    );
    await issuer.globalUnfreeze();
    log('  [ok] lifted the global freeze');

    log('\n--- Holder B: clawback, ends frozen ---');
    await issuer.pay(holderB.address, '1000');
    log('  [ok] paid B 1000');
    await issuer.clawback(holderB.address, '300');
    log('  [ok] clawed back 300 from B (expect balance 700)');
    await issuer.freezeHolder(holderB.address);
    log('  [ok] froze B (left frozen)');

    log('\n--- Holder C: banned ---');
    await issuer.pay(holderC.address, '250');
    log('  [ok] paid C 250');
    await issuer.banHolder(holderC.address);
    log('  [ok] banned C (clawed back full balance and revoked allowlist approval)');
    await expectRejected('a payment to banned holder C', () => issuer.pay(holderC.address, '1'));

    log('\n--- Final on-ledger state ---');
    const issuanceState = await issuer.getIssuanceState();
    log(`Issuance: ${JSON.stringify(issuanceState, null, 2)}`);

    const [stateA, stateB, stateC] = await Promise.all([
      issuer.getHolderState(holderA.address),
      issuer.getHolderState(holderB.address),
      issuer.getHolderState(holderC.address),
    ]);
    log(`Holder A: ${JSON.stringify(stateA, null, 2)}`);
    log(`Holder B: ${JSON.stringify(stateB, null, 2)}`);
    log(`Holder C: ${JSON.stringify(stateC, null, 2)}`);

    if (stateA.balance !== '500' || stateA.frozen) {
      throw new Error(`Unexpected final state for A: ${JSON.stringify(stateA)}`);
    }
    if (stateB.balance !== '700' || !stateB.frozen) {
      throw new Error(`Unexpected final state for B: ${JSON.stringify(stateB)}`);
    }
    if (stateC.balance !== '0' || stateC.authorized) {
      throw new Error(`Unexpected final state for C: ${JSON.stringify(stateC)}`);
    }
    if (issuanceState.globallyLocked) {
      throw new Error('Issuance should not be globally locked at the end of the demo');
    }
    log('\n[ok] final state matches expectations');

    const resultPath = path.join(__dirname, '..', 'result.json');
    writeFileSync(
      resultPath,
      JSON.stringify(
        {
          issuanceId,
          holders: {
            A: holderA.address,
            B: holderB.address,
            C: holderC.address,
          },
        },
        null,
        2,
      ) + '\n',
    );
    log(`\nWrote ${resultPath}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
