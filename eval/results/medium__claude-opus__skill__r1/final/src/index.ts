import { writeFile } from "node:fs/promises";
import {
  Client,
  LedgerEntry,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type Payment,
  type LedgerEntryRequest,
  type LedgerEntryResponse,
  type SubmittableTransaction,
  type TxResponse,
} from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const SEND_AMOUNT = "1000";
// Extra XRP given to the holder on top of its reserves, to pay transaction fees.
const HOLDER_FEE_BUFFER_XRP = 1;

// MPToken ledger-entry flag (xrpl.js doesn't export an enum for it).
const lsfMPTAuthorized = 0x00000002;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

async function submit<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
  label: string,
): Promise<TxResponse<T>> {
  // submitAndWait autofills Fee/Sequence/LastLedgerSequence and waits for validation.
  const response = await client.submitAndWait(tx, { wallet, autofill: true });
  const meta = response.result.meta;
  const code = typeof meta === "object" ? meta.TransactionResult : "unknown";
  if (!response.result.validated || code !== "tesSUCCESS") {
    throw new Error(`${label} failed: ${code} (tx ${response.result.hash})`);
  }
  console.log(`✔ ${label} (tx ${response.result.hash})`);
  return response;
}

// xrpl.js's generic LedgerEntry union doesn't include MPToken, so let the
// caller name the expected entry type; readers still check LedgerEntryType.
async function getLedgerEntry<T>(
  client: Client,
  req: Omit<LedgerEntryRequest, "command">,
): Promise<T | undefined> {
  const response = await client.request<LedgerEntryRequest, 2, LedgerEntryResponse<T>>({
    command: "ledger_entry",
    ...req,
  });
  return response.result.node;
}

async function main(): Promise<void> {
  const issuer = Wallet.fromSeed(requireEnv("XRPL_ISSUER_SEED"));
  const client = new Client(TESTNET_URL);
  await client.connect();

  try {
    console.log(`Issuer: ${issuer.classicAddress}`);

    // 1. Create the MPT issuance. tfMPTRequireAuth means only holders the
    //    issuer explicitly authorizes can hold the token.
    const createTx: MPTokenIssuanceCreate = {
      TransactionType: "MPTokenIssuanceCreate",
      Account: issuer.classicAddress,
      AssetScale: 0,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    };
    const created = await submit(client, issuer, createTx, "MPTokenIssuanceCreate");
    const createMeta = created.result.meta;
    const issuanceId = typeof createMeta === "object" ? createMeta.mpt_issuance_id : undefined;
    if (!issuanceId) {
      throw new Error("MPTokenIssuanceCreate succeeded but no mpt_issuance_id in metadata");
    }
    console.log(`  Issuance ID: ${issuanceId}`);

    // 2a. Create and fund the holder account from the issuer. It needs the
    //     base reserve plus one owner reserve for its MPToken entry.
    const holder = Wallet.generate();
    const { info } = (await client.request({ command: "server_info" })).result;
    const ledgerInfo = info.validated_ledger;
    if (!ledgerInfo) {
      throw new Error("Server has no validated ledger; cannot read reserves");
    }
    const fundXrp =
      ledgerInfo.reserve_base_xrp + ledgerInfo.reserve_inc_xrp + HOLDER_FEE_BUFFER_XRP;
    const fundTx: Payment = {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(fundXrp),
    };
    await submit(client, issuer, fundTx, `Fund holder ${holder.classicAddress} with ${fundXrp} XRP`);
    // Keep the holder's keys (gitignored) so the account stays usable after this run.
    await writeFile(
      "holder-wallet.json",
      JSON.stringify({ address: holder.classicAddress, seed: holder.seed }, null, 2) + "\n",
      { mode: 0o600 },
    );

    // 2b. Holder opts in to the token (creates its MPToken ledger entry).
    const holderOptIn: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    };
    await submit(client, holder, holderOptIn, "Holder opt-in (MPTokenAuthorize)");

    // 2c. Issuer approves the holder (required because of tfMPTRequireAuth).
    const issuerApprove: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    };
    await submit(client, issuer, issuerApprove, "Issuer approval (MPTokenAuthorize)");

    // 3. Send the holder 1,000 of the token.
    const sendTx: Payment = {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: SEND_AMOUNT },
    };
    await submit(client, issuer, sendTx, `Send ${SEND_AMOUNT} MPT to holder`);

    // 4. Read balances back from the latest validated ledger.
    const issuanceEntry = await getLedgerEntry<LedgerEntry.MPTokenIssuance>(client, {
      mpt_issuance: issuanceId,
      ledger_index: "validated",
    });
    const tokenEntry = await getLedgerEntry<LedgerEntry.MPToken>(client, {
      mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
      ledger_index: "validated",
    });
    if (
      issuanceEntry?.LedgerEntryType !== "MPTokenIssuance" ||
      tokenEntry?.LedgerEntryType !== "MPToken"
    ) {
      throw new Error("Could not read MPT ledger entries back from the ledger");
    }

    // rippled omits zero-valued amount fields.
    const holderBalance = tokenEntry.MPTAmount ?? "0";
    const outstandingAmount = issuanceEntry.OutstandingAmount ?? "0";

    console.log("\nOn-ledger state (validated):");
    console.log(`  Holder ${holder.classicAddress} balance: ${holderBalance}`);
    console.log(`  Outstanding (in circulation): ${outstandingAmount}`);
    console.log(`  Issuance requires auth: ${(issuanceEntry.Flags & LedgerEntry.MPTokenIssuanceFlags.lsfMPTRequireAuth) !== 0}`);
    console.log(`  Holder authorized by issuer: ${(tokenEntry.Flags & lsfMPTAuthorized) !== 0}`);

    const issuerXrp = await client.getXrpBalance(issuer.classicAddress);
    console.log(`  Issuer XRP balance: ${issuerXrp}`);

    const result = {
      issuanceId,
      holder: holder.classicAddress,
      holderBalance,
      outstandingAmount,
    };
    await writeFile("result.json", JSON.stringify(result, null, 2) + "\n");
    console.log("\nWrote result.json");
  } finally {
    await client.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
