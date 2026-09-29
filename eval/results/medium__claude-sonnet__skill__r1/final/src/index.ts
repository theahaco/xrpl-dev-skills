import { writeFile } from "node:fs/promises";
import {
  Client,
  Wallet,
  type MPTokenIssuanceCreate,
  type MPTokenAuthorize,
  type Payment,
  LedgerEntry,
} from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";

// tfMPTRequireAuth: only holders the issuer has explicitly authorized may hold the MPT.
const tfMPTRequireAuth = 0x00000004;

const ISSUER_SEED = "<TESTNET_SEED_REDACTED>";
const HOLDER_FUNDING_XRP = "15";
const MPT_AMOUNT_TO_SEND = "1000";

async function main(): Promise<void> {
  const client = new Client(TESTNET_URL);
  await client.connect();

  try {
    const issuerWallet = Wallet.fromSeed(ISSUER_SEED);
    const holderWallet = Wallet.generate();

    console.log(`Issuer:  ${issuerWallet.address}`);
    console.log(`Holder:  ${holderWallet.address}`);

    // 1. Activate the holder account by funding it from the issuer.
    await submit(client, issuerWallet, {
      TransactionType: "Payment",
      Account: issuerWallet.address,
      Destination: holderWallet.address,
      Amount: String(Number(HOLDER_FUNDING_XRP) * 1_000_000),
    } satisfies Payment);
    console.log(`Funded holder with ${HOLDER_FUNDING_XRP} XRP`);

    // 2. Issue a new MPT that requires per-holder authorization from the issuer.
    const issuanceCreateResult = await submit(client, issuerWallet, {
      TransactionType: "MPTokenIssuanceCreate",
      Account: issuerWallet.address,
      AssetScale: 2,
      MaximumAmount: "1000000000",
      Flags: tfMPTRequireAuth,
    } satisfies MPTokenIssuanceCreate);

    const meta = issuanceCreateResult.result.meta;
    if (typeof meta !== "object" || meta === null || !("mpt_issuance_id" in meta)) {
      throw new Error("MPTokenIssuanceCreate did not return an mpt_issuance_id");
    }
    const issuanceId = meta.mpt_issuance_id as string;
    console.log(`Created MPT issuance: ${issuanceId}`);

    // 3. Holder opts in to the MPT.
    await submit(client, holderWallet, {
      TransactionType: "MPTokenAuthorize",
      Account: holderWallet.address,
      MPTokenIssuanceID: issuanceId,
    } satisfies MPTokenAuthorize);
    console.log("Holder opted in (MPTokenAuthorize)");

    // 4. Issuer approves the holder (required because tfMPTRequireAuth is set).
    await submit(client, issuerWallet, {
      TransactionType: "MPTokenAuthorize",
      Account: issuerWallet.address,
      MPTokenIssuanceID: issuanceId,
      Holder: holderWallet.address,
    } satisfies MPTokenAuthorize);
    console.log("Issuer approved holder");

    // 5. Send the holder 1,000 of the token.
    await submit(client, issuerWallet, {
      TransactionType: "Payment",
      Account: issuerWallet.address,
      Destination: holderWallet.address,
      Amount: {
        mpt_issuance_id: issuanceId,
        value: MPT_AMOUNT_TO_SEND,
      },
    } satisfies Payment);
    console.log(`Sent ${MPT_AMOUNT_TO_SEND} of the MPT to the holder`);

    // 6. Read balances back from the ledger.
    const mptokenResponse = await client.request({
      command: "ledger_entry",
      mptoken: {
        mpt_issuance_id: issuanceId,
        account: holderWallet.address,
      },
    });
    const holderMPToken = mptokenResponse.result.node as unknown as LedgerEntry.MPToken;
    const holderBalance = holderMPToken.MPTAmount;

    const issuanceResponse = await client.request({
      command: "ledger_entry",
      mpt_issuance: issuanceId,
    });
    const issuance = issuanceResponse.result.node as unknown as LedgerEntry.MPTokenIssuance;
    const outstandingAmount = issuance.OutstandingAmount;

    console.log(`Holder balance:      ${holderBalance}`);
    console.log(`Outstanding amount:  ${outstandingAmount}`);

    await writeFile(
      new URL("../result.json", import.meta.url),
      JSON.stringify(
        {
          issuanceId,
          holder: holderWallet.address,
          holderBalance,
          outstandingAmount,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("Wrote result.json");
  } finally {
    await client.disconnect();
  }
}

async function submit(
  client: Client,
  wallet: Wallet,
  transaction: Parameters<Client["autofill"]>[0],
): ReturnType<Client["submitAndWait"]> {
  const prepared = await client.autofill(transaction);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  const meta = result.result.meta;
  const engineResult =
    typeof meta === "object" && meta !== null && "TransactionResult" in meta
      ? (meta as { TransactionResult: string }).TransactionResult
      : undefined;

  if (engineResult !== "tesSUCCESS") {
    throw new Error(
      `${transaction.TransactionType} failed: ${engineResult ?? "unknown result"}`,
    );
  }

  return result;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
