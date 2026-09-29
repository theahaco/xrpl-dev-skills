import * as fs from "node:fs";
import * as path from "node:path";
import { Wallet, type Client } from "xrpl";

import {
  MptIssuer,
  connectTestnetClient,
  toBaseUnits,
  submitAndVerify,
  TransactionFailedError,
} from "../src";

const ISSUER_SEED = "<TESTNET_SEED_REDACTED>";
// AssetScale is a display-only convention (the ledger always stores/moves
// raw integers); use 0 so the raw amounts on the ledger equal the
// human-readable amounts used throughout this demo.
const ASSET_SCALE = 0;
const HOLDER_STARTING_XRP = "5";

function log(message: string): void {
  console.log(message);
}

async function expectFailure(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof TransactionFailedError) {
      log(`  [OK] ${label} correctly rejected (${error.resultCode})`);
      return;
    }
    throw error;
  }
  throw new Error(`Expected "${label}" to fail, but it succeeded`);
}

async function fundFromIssuer(
  client: Client,
  issuerWallet: Wallet,
  destination: string,
  amountXrp: string,
): Promise<void> {
  await submitAndVerify(client, issuerWallet, {
    TransactionType: "Payment",
    Account: issuerWallet.address,
    Destination: destination,
    Amount: (Number(amountXrp) * 1_000_000).toString(),
  });
}

async function holderOptIn(client: Client, holderWallet: Wallet, issuanceId: string): Promise<void> {
  await submitAndVerify(client, holderWallet, {
    TransactionType: "MPTokenAuthorize",
    Account: holderWallet.address,
    MPTokenIssuanceID: issuanceId,
  });
}

async function holderPayment(
  client: Client,
  fromWallet: Wallet,
  toAddress: string,
  issuanceId: string,
  value: string,
): Promise<void> {
  await submitAndVerify(client, fromWallet, {
    TransactionType: "Payment",
    Account: fromWallet.address,
    Destination: toAddress,
    Amount: { mpt_issuance_id: issuanceId, value },
  });
}

async function main(): Promise<void> {
  const client = await connectTestnetClient();

  try {
    const issuerWallet = Wallet.fromSeed(ISSUER_SEED);
    const issuer = new MptIssuer(client, issuerWallet);
    log(`Issuer: ${issuerWallet.address}`);

    const walletA = Wallet.generate();
    const walletB = Wallet.generate();
    const walletC = Wallet.generate();
    log(`Holder A: ${walletA.address}`);
    log(`Holder B: ${walletB.address}`);
    log(`Holder C: ${walletC.address}`);

    log("\n== Funding holder accounts from issuer ==");
    for (const wallet of [walletA, walletB, walletC]) {
      await fundFromIssuer(client, issuerWallet, wallet.address, HOLDER_STARTING_XRP);
      log(`  Funded ${wallet.address} with ${HOLDER_STARTING_XRP} XRP`);
    }

    log("\n== Creating MPT issuance ==");
    const { issuanceId } = await issuer.createIssuance({
      assetScale: ASSET_SCALE,
      maximumAmount: toBaseUnits("1000000000", ASSET_SCALE),
      transferFee: 0,
      metadata: {
        ticker: "RUSD",
        name: "Regulated Demo Stablecoin",
        desc: "Testnet demo of a compliance-controlled stablecoin-style MPT issuance",
        icon: "https://example.com/rusd-icon.png",
        asset_class: "rwa",
        asset_subclass: "stablecoin",
        issuer_name: "Demo Issuer",
      },
      allowHolderToHolderTransfer: true,
    });
    log(`  Issuance ID: ${issuanceId}`);

    const issuanceState = await issuer.getIssuance(issuanceId);
    log(
      `  Flags -> requireAuth=${issuanceState.requireAuth} canLock=${issuanceState.canLock} canClawback=${issuanceState.canClawback}`,
    );
    if (!issuanceState.requireAuth || !issuanceState.canLock || !issuanceState.canClawback) {
      throw new Error("Issuance is missing a required compliance flag");
    }

    log("\n== Allowlist: sending before opt-in must fail ==");
    await expectFailure("Payment to A before opt-in", () =>
      issuer.sendTokens(issuanceId, walletA.address, "1"),
    );

    log("\n== Holders opt in (MPTokenAuthorize) ==");
    for (const wallet of [walletA, walletB, walletC]) {
      await holderOptIn(client, wallet, issuanceId);
      log(`  ${wallet.address} opted in`);
    }

    log("\n== Allowlist: sending before issuer approval must still fail ==");
    await expectFailure("Payment to C before issuer approval", () =>
      issuer.sendTokens(issuanceId, walletC.address, "1"),
    );

    log("\n== Allowlist: issuer approves A, B, C ==");
    for (const [label, wallet] of [
      ["A", walletA],
      ["B", walletB],
      ["C", walletC],
    ] as const) {
      await issuer.approveHolder(issuanceId, wallet.address);
      const state = await issuer.getHolder(issuanceId, wallet.address);
      log(`  Holder ${label} approved, authorized=${state?.authorized}`);
    }

    log("\n== Distributing tokens ==");
    await issuer.sendTokens(issuanceId, walletA.address, "500");
    log("  Sent 500 to A");
    await issuer.sendTokens(issuanceId, walletB.address, "1000");
    log("  Sent 1000 to B");
    await issuer.sendTokens(issuanceId, walletC.address, "200");
    log("  Sent 200 to C");

    log("\n== Per-holder freeze: freezing A ==");
    await issuer.freezeHolder(issuanceId, walletA.address);
    // A locked holder can still redeem back to the issuer (mirrors
    // trustline-freeze semantics), so the meaningful check is that they
    // cannot move funds to another holder.
    await expectFailure("A sending to another holder while frozen", () =>
      holderPayment(client, walletA, walletB.address, issuanceId, "1"),
    );
    await expectFailure("A receiving from another holder while frozen", () =>
      holderPayment(client, walletB, walletA.address, issuanceId, "1"),
    );
    log("  Unfreezing A");
    await issuer.unfreezeHolder(issuanceId, walletA.address);
    const aState = await issuer.getHolder(issuanceId, walletA.address);
    log(`  A locked=${aState?.locked} balance=${aState?.balance}`);

    log("\n== Global freeze: locking the entire issuance (while A, B, C are all active) ==");
    await issuer.globalFreeze(issuanceId);
    // Like the per-holder lock, the issuer remains an exempt counterparty
    // under global lock (so clawback and administrative payments keep
    // working during an incident) — the meaningful check is that transfers
    // between two ordinary holders are blocked.
    await expectFailure("A paying B during global freeze", () =>
      holderPayment(client, walletA, walletB.address, issuanceId, "1"),
    );
    log("  Unfreezing globally");
    await issuer.globalUnfreeze(issuanceId);
    const globalFreezeState = await issuer.getIssuance(issuanceId);
    log(`  globallyLocked=${globalFreezeState.globallyLocked}`);

    log("\n== Clawback: clawing back 300 from B ==");
    await issuer.clawback(issuanceId, walletB.address, "300");
    const bAfterClawback = await issuer.getHolder(issuanceId, walletB.address);
    log(`  B balance is now ${bAfterClawback?.balance}`);

    log("\n== Per-holder freeze: freezing B (left frozen) ==");
    await issuer.freezeHolder(issuanceId, walletB.address);
    const bState = await issuer.getHolder(issuanceId, walletB.address);
    log(`  B locked=${bState?.locked}`);

    log("\n== Ban: banning C ==");
    await issuer.banHolder(issuanceId, walletC.address);
    const cState = await issuer.getHolder(issuanceId, walletC.address);
    log(`  C balance=${cState?.balance} authorized=${cState?.authorized}`);
    await expectFailure("Payment to banned C", () =>
      issuer.sendTokens(issuanceId, walletC.address, "1"),
    );

    const finalIssuanceState = await issuer.getIssuance(issuanceId);

    log("\n== Final state ==");
    const finalA = await issuer.getHolder(issuanceId, walletA.address);
    const finalB = await issuer.getHolder(issuanceId, walletB.address);
    const finalC = await issuer.getHolder(issuanceId, walletC.address);
    log(`  A: balance=${finalA?.balance} locked=${finalA?.locked} authorized=${finalA?.authorized}`);
    log(`  B: balance=${finalB?.balance} locked=${finalB?.locked} authorized=${finalB?.authorized}`);
    log(`  C: balance=${finalC?.balance} locked=${finalC?.locked} authorized=${finalC?.authorized}`);

    if (finalA?.balance !== "500" || finalA.locked !== false) {
      throw new Error("Holder A final state does not match expectations");
    }
    if (finalB?.balance !== "700" || finalB.locked !== true) {
      throw new Error("Holder B final state does not match expectations");
    }
    if (finalC?.balance !== "0" || finalC.authorized !== false) {
      throw new Error("Holder C final state does not match expectations");
    }
    if (finalIssuanceState.globallyLocked !== false) {
      throw new Error("Issuance should not be globally locked at the end of the demo");
    }

    const result = {
      issuanceId,
      holders: {
        A: walletA.address,
        B: walletB.address,
        C: walletC.address,
      },
    };
    const resultPath = path.join(process.cwd(), "result.json");
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
    log(`\nWrote ${resultPath}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
