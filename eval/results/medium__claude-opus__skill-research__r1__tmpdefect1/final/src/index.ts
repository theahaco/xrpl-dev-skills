import { writeFile } from "node:fs/promises";
import {
  Client,
  DEFAULT_API_VERSION,
  ECDSA,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type LedgerEntry,
  type LedgerEntryRequest,
  type LedgerEntryResponse,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type Payment,
  type SubmittableTransaction,
  type TxResponse,
} from "xrpl";

const TESTNET = "wss://s.altnet.rippletest.net:51233";
// AssetScale 0 means one on-ledger unit is one whole token, so "1000" is 1,000 tokens.
const AMOUNT_TO_SEND = "1000";
// Testnet reserves are 1 XRP base + 0.2 XRP per owned object (the holder's MPToken
// entry), so 3 XRP covers the holder's reserves and fees with room to spare.
const HOLDER_FUNDING_XRP = "3";

async function submit<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
): Promise<TxResponse<T>> {
  // submitAndWait autofills Fee, Sequence, LastLedgerSequence and NetworkID,
  // and resolves only once the transaction is in a validated ledger.
  const response = await client.submitAndWait(tx, { wallet, autofill: true });
  const meta = response.result.meta;
  const result = typeof meta === "object" ? meta.TransactionResult : "unknown";
  if (!response.result.validated || result !== "tesSUCCESS") {
    throw new Error(`${tx.TransactionType} failed: ${result} (${response.result.hash})`);
  }
  console.log(`  ${tx.TransactionType} validated: ${response.result.hash}`);
  return response;
}

// xrpl 5.3.0's default LedgerEntry union omits MPToken, so callers name the entry type.
async function getLedgerEntry<T extends { LedgerEntryType: string }>(
  client: Client,
  request: LedgerEntryRequest,
): Promise<T> {
  const response = await client.request<
    LedgerEntryRequest,
    typeof DEFAULT_API_VERSION,
    LedgerEntryResponse<T>
  >(request);
  const node = response.result.node;
  if (!node) throw new Error(`ledger_entry returned no node: ${JSON.stringify(request)}`);
  return node;
}

async function main(): Promise<void> {
  const seed = process.env["ISSUER_SEED"];
  if (!seed) throw new Error("ISSUER_SEED is not set (see .env)");
  // xrpl 5.x infers the algorithm from the seed prefix; be explicit anyway.
  const issuer = Wallet.fromSeed(seed, { algorithm: ECDSA.ed25519 });

  const client = new Client(TESTNET);
  await client.connect();
  try {
    console.log(`Issuer: ${issuer.classicAddress}`);

    // 1. Create the issuance. tfMPTRequireAuth allow-lists holders; tfMPTCanTransfer
    //    is deliberately not set, so holders can only send the token back to the issuer.
    console.log("1. Creating MPT issuance");
    const created = await submit<MPTokenIssuanceCreate>(client, issuer, {
      TransactionType: "MPTokenIssuanceCreate",
      Account: issuer.classicAddress,
      AssetScale: 0,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    });
    const meta = created.result.meta;
    const issuanceId = typeof meta === "object" ? meta.mpt_issuance_id : undefined;
    if (!issuanceId) throw new Error("mpt_issuance_id missing from transaction metadata");
    console.log(`  Issuance ID: ${issuanceId}`);

    // 2. Create and fund the holder, have it opt in, then approve it as the issuer.
    console.log("2. Setting up holder");
    const holder = Wallet.generate(ECDSA.ed25519);
    console.log(`  Holder: ${holder.classicAddress} (seed: ${holder.seed})`);
    await submit<Payment>(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    });
    await submit<MPTokenAuthorize>(client, holder, {
      TransactionType: "MPTokenAuthorize",
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    });
    await submit<MPTokenAuthorize>(client, issuer, {
      TransactionType: "MPTokenAuthorize",
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    });

    // 3. Send the holder the tokens.
    console.log(`3. Sending ${AMOUNT_TO_SEND} tokens to holder`);
    await submit<Payment>(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: AMOUNT_TO_SEND },
    });

    // 4. Read balances back from the latest validated ledger. rippled omits
    //    zero-valued amount fields, so a missing field means "0".
    console.log("4. Reading balances from the ledger");
    const tokenNode = await getLedgerEntry<LedgerEntry.MPToken>(client, {
      command: "ledger_entry",
      mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
      ledger_index: "validated",
    });
    const issuanceNode = await getLedgerEntry<LedgerEntry.MPTokenIssuance>(client, {
      command: "ledger_entry",
      mpt_issuance: issuanceId,
      ledger_index: "validated",
    });
    const holderBalance = tokenNode.MPTAmount ?? "0";
    const outstandingAmount = issuanceNode.OutstandingAmount ?? "0";
    console.log(`  Holder balance:     ${holderBalance}`);
    console.log(`  Total outstanding:  ${outstandingAmount}`);

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
