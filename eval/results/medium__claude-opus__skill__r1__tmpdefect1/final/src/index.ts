import { writeFile } from "node:fs/promises";
import {
  Client,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type SubmittableTransaction,
  type TxResponse,
} from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const AMOUNT_TO_SEND = "1000";

async function submit(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<TxResponse> {
  // autofill sets Fee, Sequence and LastLedgerSequence; submitAndWait waits for a validated ledger.
  const response = await client.submitAndWait(tx, { wallet, autofill: true });
  const meta = response.result.meta;
  const result = typeof meta === "object" ? meta.TransactionResult : "unknown";
  if (result !== "tesSUCCESS") {
    throw new Error(`${tx.TransactionType} failed: ${result} (${response.result.hash})`);
  }
  console.log(`  ${tx.TransactionType} validated: ${response.result.hash}`);
  return response;
}

async function main(): Promise<void> {
  const issuerSeed = process.env.ISSUER_SEED;
  if (!issuerSeed) throw new Error("Set ISSUER_SEED to the issuer account's secret seed");
  const issuer = Wallet.fromSeed(issuerSeed);

  const client = new Client(TESTNET_URL);
  await client.connect();
  try {
    console.log(`Issuer: ${issuer.classicAddress}`);

    // 1. Create the issuance. tfMPTRequireAuth means only issuer-approved holders may hold it.
    console.log("Creating MPT issuance...");
    const created = await submit(client, issuer, {
      TransactionType: "MPTokenIssuanceCreate",
      Account: issuer.classicAddress,
      AssetScale: 0,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    });
    const issuanceId = (created.result.meta as { mpt_issuance_id?: string } | undefined)
      ?.mpt_issuance_id;
    if (!issuanceId) throw new Error("mpt_issuance_id missing from transaction metadata");
    console.log(`  Issuance ID: ${issuanceId}`);

    // 2. Create and fund a holder account from the issuer: base reserve, one owner
    //    reserve for the MPToken object, plus 1 XRP headroom for fees.
    const holder = Wallet.generate();
    const { info } = (await client.request({ command: "server_info" })).result;
    const reserves = info.validated_ledger;
    if (!reserves) throw new Error("server_info returned no validated ledger");
    const fundingXrp = reserves.reserve_base_xrp + reserves.reserve_inc_xrp + 1;
    console.log(`Funding holder ${holder.classicAddress} with ${fundingXrp} XRP...`);
    await submit(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(fundingXrp),
    });

    // The holder opts in (creates its MPToken object), then the issuer approves it.
    console.log("Holder opting in to the MPT...");
    await submit(client, holder, {
      TransactionType: "MPTokenAuthorize",
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    });
    console.log("Issuer approving holder...");
    await submit(client, issuer, {
      TransactionType: "MPTokenAuthorize",
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    });

    // 3. Send the holder 1,000 tokens.
    console.log(`Sending ${AMOUNT_TO_SEND} tokens to holder...`);
    await submit(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: AMOUNT_TO_SEND },
    });

    // 4. Read balances back from the validated ledger.
    const mptoken = await client.request({
      command: "ledger_entry",
      mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
      ledger_index: "validated",
    });
    const issuance = await client.request({
      command: "ledger_entry",
      mpt_issuance: issuanceId,
      ledger_index: "validated",
    });
    // Zero amounts are omitted from ledger objects.
    const holderBalance =
      (mptoken.result.node as { MPTAmount?: string } | undefined)?.MPTAmount ?? "0";
    const outstandingAmount =
      (issuance.result.node as { OutstandingAmount?: string } | undefined)?.OutstandingAmount ??
      "0";

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
