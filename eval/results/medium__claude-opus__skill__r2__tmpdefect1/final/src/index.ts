import { writeFile } from "node:fs/promises";
import {
  Client,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type LedgerEntry,
  type SubmittableTransaction,
  type TransactionMetadata,
} from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
// XRP sent from the issuer to the new holder account: covers the base reserve,
// the owner reserve for its MPToken object, and fees, with room to spare.
const HOLDER_FUNDING_XRP = "5";
// AssetScale 0 means whole units, so "1000" on the ledger is 1,000 tokens.
const ASSET_SCALE = 0;
const PAYMENT_AMOUNT = "1000";

function isEntry<T extends { LedgerEntryType: string }>(
  node: unknown,
  type: T["LedgerEntryType"],
): node is T {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as { LedgerEntryType?: unknown }).LedgerEntryType === type
  );
}

async function submit(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<TransactionMetadata> {
  const result = await client.submitAndWait(tx, { wallet, autofill: true });
  const meta = result.result.meta;
  if (typeof meta !== "object" || meta.TransactionResult !== "tesSUCCESS") {
    const code = typeof meta === "object" ? meta.TransactionResult : "unknown";
    throw new Error(`${tx.TransactionType} failed: ${code}`);
  }
  console.log(`  ${tx.TransactionType} validated: ${result.result.hash}`);
  return meta;
}

async function main(): Promise<void> {
  const issuerSeed = process.env.XRPL_ISSUER_SEED;
  if (!issuerSeed) {
    throw new Error("Set XRPL_ISSUER_SEED to the issuer account's seed");
  }
  const issuer = Wallet.fromSeed(issuerSeed);

  const client = new Client(TESTNET_URL);
  await client.connect();
  try {
    console.log(`Issuer: ${issuer.classicAddress}`);

    // 1. Create the issuance. tfMPTRequireAuth means only holders the issuer
    //    has explicitly authorized can hold the token.
    console.log("Creating MPT issuance...");
    const createMeta = await submit(client, issuer, {
      TransactionType: "MPTokenIssuanceCreate",
      Account: issuer.classicAddress,
      AssetScale: ASSET_SCALE,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    });
    const issuanceId =
      "mpt_issuance_id" in createMeta ? createMeta.mpt_issuance_id : undefined;
    if (!issuanceId) {
      throw new Error("MPTokenIssuanceCreate metadata has no mpt_issuance_id");
    }
    console.log(`  Issuance ID: ${issuanceId}`);

    // 2. Create and fund a holder account from the issuer, then have the holder
    //    opt in and the issuer approve it.
    const holder = Wallet.generate();
    console.log(`Funding holder ${holder.classicAddress}...`);
    console.log(`  Holder seed (testnet only): ${holder.seed}`);
    await submit(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    });

    console.log("Holder opting in to the MPT...");
    await submit(client, holder, {
      TransactionType: "MPTokenAuthorize",
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    });

    console.log("Issuer authorizing the holder...");
    await submit(client, issuer, {
      TransactionType: "MPTokenAuthorize",
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    });

    // 3. Send the holder 1,000 tokens.
    console.log(`Sending ${PAYMENT_AMOUNT} tokens to the holder...`);
    await submit(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: PAYMENT_AMOUNT },
    });

    // 4. Read the balances back from the validated ledger.
    const token = await client.request({
      command: "ledger_entry",
      mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
      ledger_index: "validated",
    });
    const issuance = await client.request({
      command: "ledger_entry",
      mpt_issuance: issuanceId,
      ledger_index: "validated",
    });
    const tokenNode: unknown = token.result.node;
    const issuanceNode: unknown = issuance.result.node;
    if (!isEntry<LedgerEntry.MPToken>(tokenNode, "MPToken")) {
      throw new Error("Could not read the holder's MPToken entry back");
    }
    if (!isEntry<LedgerEntry.MPTokenIssuance>(issuanceNode, "MPTokenIssuance")) {
      throw new Error("Could not read the MPTokenIssuance entry back");
    }
    // MPTAmount / OutstandingAmount are omitted from the ledger when zero.
    const holderBalance = tokenNode.MPTAmount ?? "0";
    const outstandingAmount = issuanceNode.OutstandingAmount ?? "0";

    console.log(`Holder balance:     ${holderBalance}`);
    console.log(`Outstanding amount: ${outstandingAmount}`);

    const result = {
      issuanceId,
      holder: holder.classicAddress,
      holderBalance,
      outstandingAmount,
    };
    await writeFile("result.json", JSON.stringify(result, null, 2) + "\n");
    console.log("Wrote result.json");
  } finally {
    await client.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
