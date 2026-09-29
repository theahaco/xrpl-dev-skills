import { writeFile } from "node:fs/promises";
import {
  Client,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type LedgerEntry,
  type SubmittableTransaction,
  type TxResponse,
} from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
// Enough XRP to cover the holder's base reserve, the MPToken owner reserve, and fees.
const HOLDER_FUNDING_XRP = "5";
const AMOUNT_TO_SEND = "1000";

async function submit(client: Client, wallet: Wallet, tx: SubmittableTransaction): Promise<TxResponse> {
  const response = await client.submitAndWait(tx, { autofill: true, wallet });
  const meta = response.result.meta;
  const result = typeof meta === "object" ? meta.TransactionResult : undefined;
  if (result !== "tesSUCCESS") {
    throw new Error(`${tx.TransactionType} failed: ${result ?? "no metadata"}`);
  }
  console.log(`  ${tx.TransactionType} ${response.result.hash}`);
  return response;
}

async function main(): Promise<void> {
  const issuerSeed = process.env.XRPL_ISSUER_SEED;
  if (!issuerSeed) {
    throw new Error("Set XRPL_ISSUER_SEED to the issuer account's seed");
  }
  const issuer = Wallet.fromSeed(issuerSeed);
  const holder = Wallet.generate();

  const client = new Client(TESTNET_URL);
  await client.connect();
  try {
    console.log(`Issuer: ${issuer.classicAddress}`);
    console.log(`Holder: ${holder.classicAddress}`);

    // 1. Create the issuance. tfMPTRequireAuth means the issuer must approve each holder.
    console.log("Creating MPT issuance...");
    const created = await submit(client, issuer, {
      TransactionType: "MPTokenIssuanceCreate",
      Account: issuer.classicAddress,
      AssetScale: 0,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    });
    const createdMeta = created.result.meta;
    const issuanceId =
      typeof createdMeta === "object" && "mpt_issuance_id" in createdMeta
        ? createdMeta.mpt_issuance_id
        : undefined;
    if (typeof issuanceId !== "string") {
      throw new Error("MPTokenIssuanceCreate metadata did not include mpt_issuance_id");
    }
    console.log(`  Issuance ID: ${issuanceId}`);

    // 2. Fund the holder, have it opt in to the token, then approve it as the issuer.
    console.log("Funding and authorizing holder...");
    await submit(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    });
    await writeFile(
      "holder-wallet.json",
      JSON.stringify({ address: holder.classicAddress, seed: holder.seed }, null, 2) + "\n",
    );
    await submit(client, holder, {
      TransactionType: "MPTokenAuthorize",
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    });
    await submit(client, issuer, {
      TransactionType: "MPTokenAuthorize",
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    });

    // 3. Send the holder the tokens.
    console.log(`Sending ${AMOUNT_TO_SEND} tokens to holder...`);
    await submit(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: AMOUNT_TO_SEND },
    });

    // 4. Read balances back from the validated ledger.
    const issuanceNode: unknown = (
      await client.request({
        command: "ledger_entry",
        mpt_issuance: issuanceId,
        ledger_index: "validated",
      })
    ).result.node;
    const tokenNode: unknown = (
      await client.request({
        command: "ledger_entry",
        mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
        ledger_index: "validated",
      })
    ).result.node;
    // Amount fields default to zero and are omitted from the ledger entry when zero.
    const outstandingAmount = (issuanceNode as LedgerEntry.MPTokenIssuance).OutstandingAmount ?? "0";
    const holderBalance = (tokenNode as LedgerEntry.MPToken).MPTAmount ?? "0";

    console.log(`Holder balance:     ${holderBalance}`);
    console.log(`Outstanding amount: ${outstandingAmount}`);

    const result = { issuanceId, holder: holder.classicAddress, holderBalance, outstandingAmount };
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
