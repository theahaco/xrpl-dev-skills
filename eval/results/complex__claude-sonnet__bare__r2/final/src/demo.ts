/**
 * End-to-end demo of the MptIssuer compliance controls against XRP Ledger
 * testnet. Issues a token from the configured issuer account, onboards three
 * holders (A, B, C), and exercises every control: allowlist, payments,
 * per-holder freeze/unfreeze, clawback, bans, and global freeze/unfreeze.
 *
 * Run with: npm run demo
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client, Wallet, encodeMPTokenMetadata, xrpToDrops } from "xrpl";
import { MptComplianceError, MptIssuer, MptTransactionError } from "./mptIssuer.js";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const ISSUER_SEED = "<TESTNET_SEED_REDACTED>";
const HOLDER_FUNDING_XRP = "5";

function step(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** Runs an operation that is expected to fail against a compliance control, and reports the ledger's rejection reason. */
async function expectFailure(label: string, op: () => Promise<void>): Promise<void> {
  try {
    await op();
    throw new Error(`Expected "${label}" to be rejected by the ledger, but it succeeded`);
  } catch (err) {
    if (err instanceof MptTransactionError) {
      console.log(`  blocked as expected: ${label} -> ${err.transactionResult}`);
      return;
    }
    if (err instanceof MptComplianceError) {
      console.log(`  blocked as expected (application-level guard): ${label} -> ${err.message}`);
      return;
    }
    throw err;
  }
}

async function fundFromIssuer(
  client: Client,
  issuerWallet: Wallet,
  destination: string,
  xrpAmount: string,
): Promise<void> {
  const response = await client.submitAndWait(
    {
      TransactionType: "Payment",
      Account: issuerWallet.address,
      Destination: destination,
      Amount: xrpToDrops(xrpAmount),
    },
    { wallet: issuerWallet, autofill: true },
  );
  const meta = response.result.meta;
  if (!meta || typeof meta === "string" || meta.TransactionResult !== "tesSUCCESS") {
    throw new Error(`Failed to fund ${destination}: ${JSON.stringify(meta)}`);
  }
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_URL);
  await client.connect();

  try {
    const issuerWallet = Wallet.fromSeed(ISSUER_SEED);
    console.log(`Issuer: ${issuerWallet.address}`);

    const issuer = new MptIssuer(client, issuerWallet);

    // -----------------------------------------------------------------
    step("Create MPT issuance with every compliance control enabled");
    // -----------------------------------------------------------------
    const metadataHex = encodeMPTokenMetadata({
      ticker: "RWD",
      name: "Regulated Wyndham Dollar",
      desc: "Testnet demo of a regulated, stablecoin-style MPT issued by the compliance team.",
      icon: "https://example.com/rwd-icon.png",
      asset_class: "rwa",
      asset_subclass: "stablecoin",
      issuer_name: "Wyndham Tech",
    });
    const issuanceId = await issuer.createIssuance({
      assetScale: 0,
      metadataHex,
    });
    console.log(`Issuance ID: ${issuanceId}`);

    // -----------------------------------------------------------------
    step("Create and fund holder accounts A, B, C");
    // -----------------------------------------------------------------
    const walletA = Wallet.generate();
    const walletB = Wallet.generate();
    const walletC = Wallet.generate();
    for (const [label, wallet] of [
      ["A", walletA],
      ["B", walletB],
      ["C", walletC],
    ] as const) {
      await fundFromIssuer(client, issuerWallet, wallet.address, HOLDER_FUNDING_XRP);
      console.log(`  funded holder ${label}: ${wallet.address}`);
    }

    // -----------------------------------------------------------------
    step("Holders opt in, issuer approves them (allowlist / KYC)");
    // -----------------------------------------------------------------
    for (const [label, wallet] of [
      ["A", walletA],
      ["B", walletB],
      ["C", walletC],
    ] as const) {
      await issuer.optIn(wallet);
      await issuer.approveHolder(wallet.address);
      console.log(`  approved holder ${label}`);
    }

    // -----------------------------------------------------------------
    step("Pay holder A 500, then demonstrate per-holder freeze");
    // -----------------------------------------------------------------
    await issuer.pay(issuerWallet, walletA.address, "500");
    console.log("  issuer -> A: 500");

    await issuer.freezeHolder(walletA.address);
    console.log("  A is now frozen");
    await expectFailure("frozen A receiving funds from the issuer", () =>
      issuer.pay(issuerWallet, walletA.address, "1"),
    );
    await expectFailure("frozen A sending funds to another holder", () =>
      issuer.pay(walletA, walletB.address, "1"),
    );

    await issuer.unfreezeHolder(walletA.address);
    console.log("  A is now unfrozen");

    // -----------------------------------------------------------------
    step("Pay holder B 1,000, claw back 300, then freeze B (stays frozen)");
    // -----------------------------------------------------------------
    await issuer.pay(issuerWallet, walletB.address, "1000");
    console.log("  issuer -> B: 1000");

    await issuer.clawback(walletB.address, "300");
    console.log("  clawed back 300 from B (expected balance: 700)");

    await issuer.freezeHolder(walletB.address);
    console.log("  B is now frozen (left frozen at end of demo)");

    // -----------------------------------------------------------------
    step("Pay holder C some funds, then ban C");
    // -----------------------------------------------------------------
    await issuer.pay(issuerWallet, walletC.address, "250");
    console.log("  issuer -> C: 250");

    await issuer.ban(walletC.address);
    console.log("  C is now banned (clawed back to zero, allowlist authorization revoked)");

    await expectFailure("paying a banned address", () => issuer.pay(issuerWallet, walletC.address, "10"));

    // -----------------------------------------------------------------
    step("Global freeze, verify it blocks movement, then lift it");
    // -----------------------------------------------------------------
    await issuer.globalFreeze();
    console.log("  token is now globally frozen");
    await expectFailure("payment while globally frozen", () => issuer.pay(issuerWallet, walletA.address, "1"));

    await issuer.globalUnfreeze();
    console.log("  global freeze lifted");

    // -----------------------------------------------------------------
    step("Verify final ledger state");
    // -----------------------------------------------------------------
    const [statusA, statusB, statusC, issuanceStatus] = await Promise.all([
      issuer.getHolderStatus(walletA.address),
      issuer.getHolderStatus(walletB.address),
      issuer.getHolderStatus(walletC.address),
      issuer.getIssuanceStatus(),
    ]);

    console.log("  A:", statusA);
    console.log("  B:", statusB);
    console.log("  C:", statusC);
    console.log("  issuance:", issuanceStatus);

    const assertions: Array<[boolean, string]> = [
      [statusA.balance === "500", "A should hold 500"],
      [statusA.frozen === false, "A should not be frozen"],
      [statusA.authorized === true, "A should be authorized"],
      [statusB.balance === "700", "B should hold 700"],
      [statusB.frozen === true, "B should be frozen"],
      [statusB.authorized === true, "B should be authorized"],
      [statusC.balance === "0", "C should hold 0"],
      [statusC.authorized === false, "C should not be authorized (banned)"],
      [issuanceStatus.globallyLocked === false, "issuance should not be globally locked"],
      [issuanceStatus.requireAuth === true, "issuance should require auth (allowlist)"],
      [issuanceStatus.canClawback === true, "issuance should support clawback"],
      [issuanceStatus.canLock === true, "issuance should support locking"],
    ];
    const failures = assertions.filter(([ok]) => !ok).map(([, msg]) => msg);
    if (failures.length > 0) {
      throw new Error(`Final state assertions failed:\n  - ${failures.join("\n  - ")}`);
    }
    console.log("\nAll final-state assertions passed.");

    // -----------------------------------------------------------------
    step("Write result.json");
    // -----------------------------------------------------------------
    const result = {
      issuanceId,
      holders: {
        A: walletA.address,
        B: walletB.address,
        C: walletC.address,
      },
    };
    const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "result.json");
    writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
    console.log(`Wrote ${outPath}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
