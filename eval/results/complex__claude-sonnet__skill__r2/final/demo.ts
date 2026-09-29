/**
 * End-to-end demo of the MPT issuer module against XRPL testnet.
 *
 * Exercises every compliance control (allowlist, per-holder freeze, global
 * freeze, clawback, ban) using the caller's own issuer account and three
 * freshly generated holder accounts (A, B, C), then writes result.json
 * with the issuance ID and holder addresses.
 *
 * Usage: copy .env.example to .env, set ISSUER_SEED, then `npm run demo`.
 */
import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Payment } from "xrpl";
import { Wallet, xrpToDrops } from "xrpl";
import { createTestnetClient, MptIssuer, optInHolder } from "./src";
import { assertTesSuccess } from "./src/submit";

const EXPECTED_ISSUER_ADDRESS = "raumV49ykMBFDiSBykLUBo1nbzxFYTeBaX";
const HOLDER_FUNDING_XRP = "5";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${label} — expected ${expected}, got ${actual}`);
  }
}

function assertTrue(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

/** Activates and funds a fresh holder account by sending XRP from the issuer. */
async function fundFromIssuer(
  client: ReturnType<typeof createTestnetClient>,
  issuerWallet: Wallet,
  destination: string,
): Promise<void> {
  const tx: Payment = {
    TransactionType: "Payment",
    Account: issuerWallet.address,
    Destination: destination,
    Amount: xrpToDrops(HOLDER_FUNDING_XRP),
  };
  const response = await client.submitAndWait(tx, { wallet: issuerWallet });
  assertTesSuccess(response);
}

async function main(): Promise<void> {
  const client = createTestnetClient();
  await client.connect();

  try {
    const issuerWallet = Wallet.fromSeed(requireEnv("ISSUER_SEED"));
    if (issuerWallet.address !== EXPECTED_ISSUER_ADDRESS) {
      throw new Error(
        `ISSUER_SEED resolves to ${issuerWallet.address}, expected ${EXPECTED_ISSUER_ADDRESS}`,
      );
    }
    console.log(`Issuer account: ${issuerWallet.address}`);

    const issuer = new MptIssuer(client, issuerWallet);

    const walletA = Wallet.generate();
    const walletB = Wallet.generate();
    const walletC = Wallet.generate();
    console.log(`Holder A: ${walletA.address}`);
    console.log(`Holder B: ${walletB.address}`);
    console.log(`Holder C: ${walletC.address}`);

    console.log("\nFunding holder accounts from the issuer...");
    for (const wallet of [walletA, walletB, walletC]) {
      await fundFromIssuer(client, issuerWallet, wallet.address);
    }

    console.log("\nCreating MPT issuance (allowlist + clawback + lock + transfer enabled)...");
    const { issuanceId } = await issuer.createIssuance({
      assetScale: 2,
      maximumAmount: "100000000000",
      transferFee: 0,
      metadata: {
        ticker: "RTS",
        name: "Regulated Test Stablecoin",
        desc: "Testnet-only demo token for issuer-side compliance controls.",
        icon: "https://example.com/rts-icon.png",
        asset_class: "rwa",
        asset_subclass: "stablecoin",
        issuer_name: "Wyndham Tech (testnet demo issuer)",
      },
    });
    console.log(`MPT issuance ID: ${issuanceId}`);

    console.log("\nHolders A, B, C opt in (create their MPToken objects)...");
    await optInHolder(client, walletA, issuanceId);
    await optInHolder(client, walletB, issuanceId);
    await optInHolder(client, walletC, issuanceId);

    console.log("Issuer approves A, B, C on the allowlist...");
    await issuer.approveHolder(issuanceId, walletA.address);
    await issuer.approveHolder(issuanceId, walletB.address);
    await issuer.approveHolder(issuanceId, walletC.address);

    console.log("\nDistributing tokens: 500 -> A, 1000 -> B, 200 -> C...");
    await issuer.send(issuanceId, walletA.address, "500");
    await issuer.send(issuanceId, walletB.address, "1000");
    await issuer.send(issuanceId, walletC.address, "200");

    console.log("\nPer-holder freeze: freezing A, confirming, then unfreezing A...");
    await issuer.freezeHolder(issuanceId, walletA.address);
    const frozenA = await issuer.getHolderState(issuanceId, walletA.address);
    assertTrue(frozenA.frozen, "A should be frozen immediately after freezeHolder");
    await issuer.unfreezeHolder(issuanceId, walletA.address);

    console.log("Clawback: clawing back 300 from B, then freezing B (left frozen)...");
    await issuer.clawback(issuanceId, walletB.address, "300");
    await issuer.freezeHolder(issuanceId, walletB.address);

    console.log("Ban: banning C (clawback full balance + freeze + revoke allowlist approval)...");
    await issuer.banHolder(issuanceId, walletC.address);

    console.log("\nGlobal freeze: freezing the whole token, confirming, then lifting it...");
    await issuer.globalFreeze(issuanceId);
    const midIssuance = await issuer.getIssuanceState(issuanceId);
    assertTrue(midIssuance.globallyLocked, "issuance should be globally locked mid-demo");
    await issuer.globalUnfreeze(issuanceId);

    console.log("\nVerifying final ledger state matches the expected end state...");
    const finalA = await issuer.getHolderState(issuanceId, walletA.address);
    const finalB = await issuer.getHolderState(issuanceId, walletB.address);
    const finalC = await issuer.getHolderState(issuanceId, walletC.address);
    const finalIssuance = await issuer.getIssuanceState(issuanceId);

    assertEqual(finalA.balance, "500", "A final balance");
    assertTrue(!finalA.frozen, "A should not be frozen at the end");
    assertTrue(finalA.authorized, "A should still be allowlisted at the end");

    assertEqual(finalB.balance, "700", "B final balance");
    assertTrue(finalB.frozen, "B should be frozen at the end");
    assertTrue(finalB.authorized, "B should still be allowlisted at the end");

    assertEqual(finalC.balance, "0", "C final balance (banned)");
    assertTrue(finalC.frozen, "C should be frozen at the end (banned)");
    assertTrue(!finalC.authorized, "C should be unauthorized at the end (banned)");

    assertTrue(!finalIssuance.globallyLocked, "issuance should not be globally locked at the end");

    console.log("All compliance controls verified against validated ledger state.");

    const result = {
      issuanceId,
      holders: {
        A: walletA.address,
        B: walletB.address,
        C: walletC.address,
      },
    };
    const resultPath = path.join(__dirname, "result.json");
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nWrote ${resultPath}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
