import { writeFile } from "node:fs/promises";
import {
  Client,
  Wallet,
  xrpToDrops,
  MPTokenIssuanceCreateFlags,
  type SubmittableTransaction,
  type TxResponse,
  type LedgerEntry,
  type LedgerEntryRequest,
  type LedgerEntryResponse,
  type DEFAULT_API_VERSION,
} from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const AMOUNT_TO_SEND = "1000";

/** Autofill, sign, submit, and wait for validation; throw unless tesSUCCESS. */
async function submit(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<TxResponse> {
  const res = await client.submitAndWait(tx, { wallet, autofill: true });
  const meta = res.result.meta;
  const code =
    typeof meta === "object" && meta !== null ? meta.TransactionResult : "unknown";
  if (!res.result.validated || code !== "tesSUCCESS") {
    throw new Error(`${tx.TransactionType} failed: ${code} (hash ${res.result.hash})`);
  }
  console.log(`  ✓ ${tx.TransactionType} validated: ${res.result.hash}`);
  return res;
}

/** rippled reports the new issuance's ID as `mpt_issuance_id` in the create tx's metadata. */
function issuanceIdFrom(res: TxResponse): string {
  const meta = res.result.meta as unknown as Record<string, unknown> | undefined;
  const id = meta?.["mpt_issuance_id"];
  if (typeof id !== "string") throw new Error("mpt_issuance_id missing from metadata");
  return id;
}

async function main(): Promise<void> {
  const seed = process.env.XRPL_SEED;
  if (!seed) throw new Error("Set XRPL_SEED to the issuer's testnet seed");

  const client = new Client(TESTNET_URL);
  await client.connect();
  try {
    const issuer = Wallet.fromSeed(seed);
    console.log(`Issuer: ${issuer.classicAddress}`);

    // 1. Create the MPT issuance. tfMPTRequireAuth means holders need issuer approval.
    console.log("1. Creating MPT issuance (RequireAuth)…");
    const createRes = await submit(client, issuer, {
      TransactionType: "MPTokenIssuanceCreate",
      Account: issuer.classicAddress,
      AssetScale: 0, // whole units, so "1000" means 1,000 tokens
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    });
    const issuanceId = issuanceIdFrom(createRes);
    console.log(`  Issuance ID: ${issuanceId}`);

    // 2a. Create and fund a holder account from the issuer.
    // Needs the base reserve plus one owner reserve for its MPToken entry, plus fee headroom.
    const info = await client.request({ command: "server_info" });
    const ledger = info.result.info.validated_ledger;
    if (!ledger) throw new Error("Server has no validated ledger");
    const fundXrp = ledger.reserve_base_xrp + 2 * ledger.reserve_inc_xrp + 1;

    const holder = Wallet.generate();
    console.log(`2. Funding holder ${holder.classicAddress} with ${fundXrp} XRP…`);
    await submit(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(fundXrp),
    });
    // Keep the holder's seed locally (gitignored) so the account stays usable.
    await writeFile(
      "holder-wallet.json",
      JSON.stringify({ address: holder.classicAddress, seed: holder.seed }, null, 2) + "\n",
      { mode: 0o600 },
    );

    // 2b. Holder opts in (creates its MPToken entry), then issuer approves it.
    console.log("   Holder opts in to the MPT…");
    await submit(client, holder, {
      TransactionType: "MPTokenAuthorize",
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    });
    console.log("   Issuer approves the holder…");
    await submit(client, issuer, {
      TransactionType: "MPTokenAuthorize",
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    });

    // 3. Send the holder 1,000 tokens.
    console.log(`3. Sending ${AMOUNT_TO_SEND} tokens to holder…`);
    await submit(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: AMOUNT_TO_SEND },
    });

    // 4. Read balances back from the latest validated ledger.
    console.log("4. Reading balances from the ledger…");
    const tokenRes = await client.request<
      LedgerEntryRequest,
      typeof DEFAULT_API_VERSION,
      LedgerEntryResponse<LedgerEntry.MPToken>
    >({
      command: "ledger_entry",
      mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
      ledger_index: "validated",
    });
    const issuanceRes = await client.request<
      LedgerEntryRequest,
      typeof DEFAULT_API_VERSION,
      LedgerEntryResponse<LedgerEntry.MPTokenIssuance>
    >({
      command: "ledger_entry",
      mpt_issuance: issuanceId,
      ledger_index: "validated",
    });
    const token = tokenRes.result.node;
    const issuance = issuanceRes.result.node;
    if (!token || !issuance) throw new Error("Ledger entries not found");

    // Both amount fields are omitted from the ledger entry when zero.
    const holderBalance = token.MPTAmount ?? "0";
    const outstandingAmount = issuance.OutstandingAmount ?? "0";
    console.log(`  Holder balance:     ${holderBalance}`);
    console.log(`  Outstanding amount: ${outstandingAmount}`);

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
  process.exit(1);
});
