import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client, Wallet, dropsToXrp, xrpToDrops } from "xrpl";

import {
  MPTStablecoinIssuer,
  MPTTransactionError,
} from "./mptStablecoinIssuer.js";

const NETWORK = process.env["XRPL_NETWORK"] ?? "wss://s.altnet.rippletest.net:51233";
const HOLDER_FUNDING_XRP = "5";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} environment variable is required (see .env).`);
  }
  return value;
}

function log(message: string): void {
  console.log(`\n=== ${message} ===`);
}

async function fundAccount(
  client: Client,
  funder: Wallet,
  destination: string,
  amountXrp: string,
): Promise<void> {
  const response = await client.submitAndWait(
    {
      TransactionType: "Payment",
      Account: funder.address,
      Destination: destination,
      Amount: xrpToDrops(amountXrp),
    },
    { autofill: true, wallet: funder },
  );
  const meta = response.result.meta;
  const result =
    typeof meta === "object" && meta !== null ? meta.TransactionResult : undefined;
  if (result !== "tesSUCCESS") {
    throw new Error(`Funding payment to ${destination} failed: ${String(result)}`);
  }
}

/**
 * Attempts an operation that is expected to fail with a specific MPT
 * transaction-result code, to prove a compliance control is actually
 * enforced on-ledger (not just assumed). Throws if the operation
 * unexpectedly succeeds or fails with a different code.
 */
async function expectBlocked(
  description: string,
  expectedResult: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof MPTTransactionError && error.engineResult === expectedResult) {
      console.log(`  [confirmed] ${description} -> blocked with ${expectedResult}`);
      return;
    }
    throw error;
  }
  throw new Error(`Expected "${description}" to fail with ${expectedResult}, but it succeeded.`);
}

async function main(): Promise<void> {
  const client = new Client(NETWORK);
  await client.connect();
  console.log(`Connected to ${NETWORK}`);

  const issuerWallet = Wallet.fromSeed(requireEnv("ISSUER_SEED"));
  console.log(`Issuer address: ${issuerWallet.address}`);

  const holderA = Wallet.generate();
  const holderB = Wallet.generate();
  const holderC = Wallet.generate();

  log("Funding holder accounts A, B, C from the issuer");
  for (const [label, wallet] of [
    ["A", holderA],
    ["B", holderB],
    ["C", holderC],
  ] as const) {
    await fundAccount(client, issuerWallet, wallet.address, HOLDER_FUNDING_XRP);
    console.log(`  Funded ${label} (${wallet.address}) with ${HOLDER_FUNDING_XRP} XRP`);
  }

  const issuer = new MPTStablecoinIssuer(client, issuerWallet);

  log("Creating the MPT issuance with all compliance controls enabled");
  const issuanceId = await issuer.createIssuance({
    assetScale: 2,
    maximumAmount: "1000000000",
    metadata: {
      ticker: "RUSD",
      name: "Regulated USD",
      desc: "Demo regulated stablecoin-style MPT with allowlist, clawback, bans, and freeze controls.",
      icon: "example.org/rusd-icon.png",
      asset_class: "rwa",
      asset_subclass: "stablecoin",
      issuer_name: "Demo Issuer Co.",
    },
  });
  console.log(`  MPTokenIssuanceID: ${issuanceId}`);

  log("Approving holders A, B, C (KYC allowlist)");
  await issuer.approveHolder(holderA);
  console.log("  A approved");
  await issuer.approveHolder(holderB);
  console.log("  B approved");
  await issuer.approveHolder(holderC);
  console.log("  C approved");

  log("Sending tokens to A (500), B (1000), C (250)");
  await issuer.sendTokens(holderA.address, "500");
  console.log("  Sent 500 to A");
  await issuer.sendTokens(holderB.address, "1000");
  console.log("  Sent 1000 to B");
  await issuer.sendTokens(holderC.address, "250");
  console.log("  Sent 250 to C");

  log("Per-holder freeze: freezing A, confirming it blocks a payment, then unfreezing");
  await issuer.freezeHolder(holderA.address);
  console.log("  A frozen");
  await expectBlocked("payment to frozen holder A", "tecLOCKED", () =>
    issuer.sendTokens(holderA.address, "1"),
  );
  await issuer.unfreezeHolder(holderA.address);
  console.log("  A unfrozen");

  log("Clawback: clawing back 300 from B (1000 -> 700)");
  await issuer.clawback(holderB.address, "300");
  const bAfterClawback = await issuer.getHolderState(holderB.address);
  console.log(`  B balance after clawback: ${bAfterClawback.balance}`);

  log("Freezing B and leaving it frozen");
  await issuer.freezeHolder(holderB.address);
  console.log("  B frozen");

  log("Banning C: clawing back their full balance and revoking authorization");
  await issuer.banHolder(holderC.address);
  const cAfterBan = await issuer.getHolderState(holderC.address);
  console.log(`  C balance after ban: ${cAfterBan.balance}, authorized: ${cAfterBan.authorized}`);
  await expectBlocked("payment to banned holder C", "tecNO_AUTH", () =>
    issuer.sendTokens(holderC.address, "1"),
  );

  log("Global freeze: locking the whole issuance, confirming it blocks a payment, then unlocking");
  await issuer.globalFreeze();
  console.log("  Issuance globally locked");
  await expectBlocked("payment while globally frozen", "tecLOCKED", () =>
    issuer.sendTokens(holderA.address, "1"),
  );
  await issuer.globalUnfreeze();
  console.log("  Issuance globally unlocked");

  log("Final state");
  const issuanceState = await issuer.getIssuanceState();
  console.log("Issuance:", issuanceState);

  const finalA = await issuer.getHolderState(holderA.address);
  const finalB = await issuer.getHolderState(holderB.address);
  const finalC = await issuer.getHolderState(holderC.address);
  console.log("Holder A:", finalA);
  console.log("Holder B:", finalB);
  console.log("Holder C:", finalC);

  const issuerInfo = await client.request({
    command: "account_info",
    account: issuerWallet.address,
  });
  console.log(
    `Issuer XRP balance remaining: ${dropsToXrp(issuerInfo.result.account_data.Balance)} XRP`,
  );

  const result = {
    issuanceId,
    holders: {
      A: holderA.address,
      B: holderB.address,
      C: holderC.address,
    },
  };

  const outputPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "result.json",
  );
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outputPath}`);

  await client.disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
