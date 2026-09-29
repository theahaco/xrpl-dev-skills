import { writeFile } from "node:fs/promises";
import {
  Client,
  type DEFAULT_API_VERSION,
  LedgerEntry,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type LedgerEntryRequest,
  type LedgerEntryResponse,
  type Payment,
  type SubmittableTransaction,
  type TxResponse,
} from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const AMOUNT_TO_SEND = "1000";
// Base reserve (1 XRP) + one MPToken owner reserve (0.2 XRP) + headroom for fees.
const HOLDER_FUNDING_XRP = "5";
// MPToken ledger entry flag: the issuer has authorized this holder.
const LSF_MPT_AUTHORIZED = 0x00000002;

const issuerSeed = process.env.XRPL_ISSUER_SEED;
if (!issuerSeed) {
  throw new Error("Set XRPL_ISSUER_SEED (e.g. in .env)");
}

async function submit<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
): Promise<TxResponse<T>> {
  // submitAndWait autofills Fee, Sequence and LastLedgerSequence, and waits
  // until the transaction is in a validated ledger.
  const response = await client.submitAndWait(tx, { wallet, autofill: true });
  const meta = response.result.meta;
  const result = typeof meta === "object" ? meta.TransactionResult : undefined;
  if (!response.result.validated || result !== "tesSUCCESS") {
    throw new Error(`${tx.TransactionType} failed: ${result ?? "no result"}`);
  }
  console.log(`${tx.TransactionType}: ${result} (${response.result.hash})`);
  return response;
}

const client = new Client(TESTNET_URL);
await client.connect();

try {
  const issuer = Wallet.fromSeed(issuerSeed);
  console.log(`Issuer: ${issuer.classicAddress}`);

  // 1. Create an MPT issuance that requires the issuer to approve each holder.
  const created = await submit<MPTokenIssuanceCreate>(client, issuer, {
    TransactionType: "MPTokenIssuanceCreate",
    Account: issuer.classicAddress,
    AssetScale: 0,
    Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
  });
  const createMeta = created.result.meta;
  const issuanceId =
    typeof createMeta === "object" ? createMeta.mpt_issuance_id : undefined;
  if (!issuanceId) {
    throw new Error("MPTokenIssuanceCreate metadata has no mpt_issuance_id");
  }
  console.log(`Issuance ID: ${issuanceId}`);

  // 2. Create and fund a holder account from the issuer.
  const holder = Wallet.generate();
  await writeFile(
    "holder-wallet.json",
    JSON.stringify({ address: holder.classicAddress, seed: holder.seed }, null, 2) + "\n",
  );
  console.log(`Holder: ${holder.classicAddress} (seed saved to holder-wallet.json)`);
  await submit<Payment>(client, issuer, {
    TransactionType: "Payment",
    Account: issuer.classicAddress,
    Destination: holder.classicAddress,
    Amount: xrpToDrops(HOLDER_FUNDING_XRP),
  });

  // The holder opts in, which creates their MPToken entry...
  await submit<MPTokenAuthorize>(client, holder, {
    TransactionType: "MPTokenAuthorize",
    Account: holder.classicAddress,
    MPTokenIssuanceID: issuanceId,
  });
  // ...and the issuer approves that holder.
  await submit<MPTokenAuthorize>(client, issuer, {
    TransactionType: "MPTokenAuthorize",
    Account: issuer.classicAddress,
    MPTokenIssuanceID: issuanceId,
    Holder: holder.classicAddress,
  });

  // 3. Send the holder 1,000 of the token.
  await submit<Payment>(client, issuer, {
    TransactionType: "Payment",
    Account: issuer.classicAddress,
    Destination: holder.classicAddress,
    Amount: { mpt_issuance_id: issuanceId, value: AMOUNT_TO_SEND },
  });

  // 4. Read the balances back from the latest validated ledger.
  const { result: tokenEntry } = await client.request<
    LedgerEntryRequest,
    typeof DEFAULT_API_VERSION,
    LedgerEntryResponse<LedgerEntry.MPToken>
  >({
    command: "ledger_entry",
    mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
    ledger_index: "validated",
  });
  const { result: issuanceEntry } = await client.request<
    LedgerEntryRequest,
    typeof DEFAULT_API_VERSION,
    LedgerEntryResponse<LedgerEntry.MPTokenIssuance>
  >({
    command: "ledger_entry",
    mpt_issuance: issuanceId,
    ledger_index: "validated",
  });
  const token = tokenEntry.node;
  const issuance = issuanceEntry.node;
  if (!token || !issuance) {
    throw new Error("MPToken or MPTokenIssuance entry not found on ledger");
  }

  // MPTAmount and OutstandingAmount are omitted from the ledger when zero.
  const holderBalance = token.MPTAmount ?? "0";
  const outstandingAmount = issuance.OutstandingAmount ?? "0";
  const holderAuthorized =
    (token.Flags & LSF_MPT_AUTHORIZED) !== 0;

  console.log(`Holder authorized by issuer: ${holderAuthorized}`);
  console.log(`Holder balance: ${holderBalance}`);
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
