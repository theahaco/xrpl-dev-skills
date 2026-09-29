/**
 * End-to-end demo of the compliance-controlled MPT issuer module against
 * XRPL testnet. Issues a token from the configured issuer account, onboards
 * three holders (A, B, C), and exercises every compliance control:
 * allowlisting, per-holder freeze, clawback, bans, and global freeze.
 *
 * Run with: npm run demo
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Wallet, xrpToDrops, type Payment } from 'xrpl';
import { MptIssuer, optInHolder } from './mptIssuer';

const TESTNET_WS = 'wss://s.altnet.rippletest.net:51233';
const ISSUER_SEED = '<TESTNET_SEED_REDACTED>';
const HOLDER_FUNDING_XRP = '3';

function log(step: string, detail?: unknown): void {
  const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`;
  console.log(`[demo] ${step}${suffix}`);
}

async function fundHolder(client: Client, issuer: Wallet, destination: string, amountXrp: string): Promise<void> {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: issuer.address,
    Destination: destination,
    Amount: xrpToDrops(amountXrp),
  };
  const response = await client.submitAndWait(tx, { wallet: issuer });
  const meta = response.result.meta;
  const resultCode = meta == null || typeof meta === 'string' ? meta : meta.TransactionResult;
  if (!response.result.validated || resultCode !== 'tesSUCCESS') {
    throw new Error(`Funding payment to ${destination} failed: ${resultCode}`);
  }
}

/**
 * Submits a holder-signed MPT payment directly (bypassing MptIssuer), used
 * only to prove that the ledger itself — not just this module's app-level
 * guards — enforces freeze at the protocol level.
 */
async function attemptRawHolderPayment(
  client: Client,
  from: Wallet,
  destination: string,
  issuanceId: string,
  value: string,
): Promise<void> {
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: from.address,
    Destination: destination,
    Amount: { mpt_issuance_id: issuanceId, value },
  };
  const response = await client.submitAndWait(tx, { wallet: from });
  const meta = response.result.meta;
  const resultCode = meta == null || typeof meta === 'string' ? meta : meta.TransactionResult;
  if (!response.result.validated || resultCode !== 'tesSUCCESS') {
    throw new Error(`Payment ${from.address} -> ${destination} failed: ${resultCode}`);
  }
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function expectFailure(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    log(`confirmed blocked: ${label}`, { reason: error instanceof Error ? error.message : String(error) });
    return;
  }
  throw new Error(`Expected "${label}" to fail, but it succeeded`);
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_WS, { maxFeeXRP: '2' });
  await client.connect();
  log('connected to testnet', { server: TESTNET_WS });

  try {
    const issuer = Wallet.fromSeed(ISSUER_SEED);
    log('issuer account', { address: issuer.address });

    const issuerXrpBalance = await client.getXrpBalance(issuer.address);
    if (issuerXrpBalance < 50) {
      log('topping up issuer via testnet faucet', { currentBalance: issuerXrpBalance });
      await client.fundWallet(issuer);
      log('issuer topped up', { newBalance: await client.getXrpBalance(issuer.address) });
    }

    const holderA = Wallet.generate();
    const holderB = Wallet.generate();
    const holderC = Wallet.generate();
    log('generated holder accounts', {
      A: holderA.address,
      B: holderB.address,
      C: holderC.address,
    });

    for (const [label, holder] of [
      ['A', holderA],
      ['B', holderB],
      ['C', holderC],
    ] as const) {
      await fundHolder(client, issuer, holder.address, HOLDER_FUNDING_XRP);
      log(`funded holder ${label} with ${HOLDER_FUNDING_XRP} XRP`, { address: holder.address });
    }

    const mpt = new MptIssuer(client, issuer);
    const created = await mpt.createIssuance({
      assetScale: 0,
      maximumAmount: '1000000000',
      transferFee: 0,
      metadata: JSON.stringify({
        icon: 'https://example.com/wrt-icon.png',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Wyndham Tech',
        name: 'Wyndham Regulated Token',
        ticker: 'WRT',
        kyc: 'required',
      }),
    });
    log('created MPT issuance', created);

    let issuance = await mpt.getIssuance();
    assertEqual('requireAuth after create', issuance.requireAuth, true);
    assertEqual('canLock after create', issuance.canLock, true);
    assertEqual('canClawback after create', issuance.canClawback, true);
    assertEqual('canTransfer after create', issuance.canTransfer, true);
    assertEqual('globallyLocked after create', issuance.globallyLocked, false);
    log('verified issuance flags', issuance);

    // --- Allowlist: each holder opts in, then the issuer approves them ---
    for (const [label, holder] of [
      ['A', holderA],
      ['B', holderB],
      ['C', holderC],
    ] as const) {
      await optInHolder(client, holder, mpt.issuanceId);
      log(`holder ${label} opted in`, { address: holder.address });
      await mpt.approveHolder(holder.address);
      log(`issuer approved holder ${label}`, { address: holder.address });
    }

    // A holder who has NOT opted in / been approved must not be able to hold the token.
    const strangerWallet = Wallet.generate();
    await fundHolder(client, issuer, strangerWallet.address, HOLDER_FUNDING_XRP);
    await expectFailure('payment to a non-allowlisted stranger', () => mpt.send(strangerWallet.address, '1'));

    // --- Fund A and B up front so later freeze tests have real balances to move ---
    await mpt.send(holderA.address, '500');
    log('sent 500 to holder A');
    await mpt.send(holderB.address, '1000');
    log('sent 1000 to holder B');

    // --- Per-holder freeze on A: prove neither side of "can't send or receive" works, then lift it ---
    await mpt.freezeHolder(holderA.address);
    let snapshotA = await mpt.getHolderMPToken(holderA.address);
    assertEqual('holder A locked after freeze', snapshotA?.locked, true);
    log('froze holder A', snapshotA);

    await expectFailure('issuer payment to frozen holder A (app-level guard)', () => mpt.send(holderA.address, '1'));
    await expectFailure('frozen holder A paying holder B (protocol-level enforcement)', () =>
      attemptRawHolderPayment(client, holderA, holderB.address, mpt.issuanceId, '10'),
    );

    await mpt.unfreezeHolder(holderA.address);
    snapshotA = await mpt.getHolderMPToken(holderA.address);
    assertEqual('holder A locked after unfreeze', snapshotA?.locked, false);
    assertEqual('holder A balance unaffected by freeze/unfreeze', snapshotA?.balance, '500');
    log('unfroze holder A', snapshotA);

    // --- Clawback 300 from B, leaving 700 ---
    await mpt.clawback(holderB.address, '300');
    let snapshotB = await mpt.getHolderMPToken(holderB.address);
    assertEqual('holder B balance after clawback', snapshotB?.balance, '700');
    log('clawed back 300 from holder B', snapshotB);

    // --- Global freeze: halts all movement for everyone, then is lifted ---
    await mpt.globalFreeze();
    issuance = await mpt.getIssuance();
    assertEqual('globallyLocked after globalFreeze', issuance.globallyLocked, true);
    log('applied global freeze', issuance);

    await expectFailure('issuer payment during global freeze (app-level guard)', () => mpt.send(holderA.address, '1'));
    await expectFailure('holder payment during global freeze (protocol-level enforcement)', () =>
      attemptRawHolderPayment(client, holderB, holderA.address, mpt.issuanceId, '5'),
    );

    await mpt.globalUnfreeze();
    issuance = await mpt.getIssuance();
    assertEqual('globallyLocked after globalUnfreeze', issuance.globallyLocked, false);
    log('lifted global freeze', issuance);

    snapshotA = await mpt.getHolderMPToken(holderA.address);
    snapshotB = await mpt.getHolderMPToken(holderB.address);
    assertEqual('holder A balance unaffected by global freeze/unfreeze', snapshotA?.balance, '500');
    assertEqual('holder B balance unaffected by global freeze/unfreeze', snapshotB?.balance, '700');

    // --- Freeze B and leave it frozen ---
    await mpt.freezeHolder(holderB.address);
    snapshotB = await mpt.getHolderMPToken(holderB.address);
    assertEqual('holder B locked at end', snapshotB?.locked, true);
    log('froze holder B (left frozen)', snapshotB);

    // --- Holder C: receives some tokens, then is banned ---
    await mpt.send(holderC.address, '200');
    log('sent 200 to holder C');

    const banResult = await mpt.banHolder(holderC.address);
    log('banned holder C', banResult);

    // On this network, revoking a zero-balance holder's authorization also
    // deletes their MPToken object outright (and refunds their reserve) —
    // an even stronger guarantee than merely clearing the authorized flag.
    const snapshotC = await mpt.getHolderMPToken(holderC.address);
    assertEqual('holder C balance after ban', snapshotC?.balance ?? '0', '0');
    assertEqual('holder C authorized after ban', snapshotC?.authorized ?? false, false);
    await expectFailure('payment to banned holder C', () => mpt.send(holderC.address, '1'));

    // --- Final state verification ---
    const finalA = await mpt.getHolderMPToken(holderA.address);
    const finalB = await mpt.getHolderMPToken(holderB.address);
    const finalC = await mpt.getHolderMPToken(holderC.address);
    const finalIssuance = await mpt.getIssuance();

    assertEqual('final A balance', finalA?.balance, '500');
    assertEqual('final A locked', finalA?.locked, false);
    assertEqual('final B balance', finalB?.balance, '700');
    assertEqual('final B locked', finalB?.locked, true);
    assertEqual('final C balance', finalC?.balance ?? '0', '0');
    assertEqual('final C authorized', finalC?.authorized ?? false, false);
    assertEqual('final outstanding amount', finalIssuance.outstandingAmount, '1200');
    assertEqual('final globallyLocked', finalIssuance.globallyLocked, false);

    log('final state verified', { finalA, finalB, finalC, finalIssuance });

    const result = {
      issuanceId: mpt.issuanceId,
      holders: {
        A: holderA.address,
        B: holderB.address,
        C: holderC.address,
      },
    };
    const resultPath = join(__dirname, '..', 'result.json');
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    log('wrote result.json', result);
  } finally {
    await client.disconnect();
    log('disconnected from testnet');
  }
}

main().catch((error) => {
  console.error('[demo] FAILED', error);
  process.exitCode = 1;
});
