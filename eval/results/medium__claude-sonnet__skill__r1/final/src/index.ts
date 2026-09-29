import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Client,
  Wallet,
  type SubmittableTransaction,
  type TxResponse,
} from "xrpl";

const TESTNET_WS = "wss://s.altnet.rippletest.net:51233";

const ISSUER_SEED = "<TESTNET_SEED_REDACTED>";
const ISSUER_ADDRESS = "rs7bubDJ24bsYsTFAsGqC54RqP83ntEDE4";

// MPT quantity fields (MaximumAmount, OutstandingAmount, MPTAmount, value) are
// UInt64 on the wire but rippled renders them as decimal strings in JSON.
const MPT_TOTAL_SUPPLY = "1000000000";
const MPT_ASSET_SCALE = 0;
const MPT_SEND_AMOUNT = "1000";

// tfMPTRequireAuth: holders must be individually approved by the issuer
// before they can hold or receive this MPT.
const tfMPTRequireAuth = 4;

async function submit(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction
): Promise<TxResponse> {
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  const meta = result.result.meta;
  const txResult =
    typeof meta === "object" && meta !== null ? meta.TransactionResult : undefined;

  if (txResult !== "tesSUCCESS") {
    throw new Error(
      `${tx.TransactionType} failed: ${txResult ?? "unknown result"}\n${JSON.stringify(
        result.result,
        null,
        2
      )}`
    );
  }

  return result;
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_WS);
  await client.connect();

  try {
    const issuer = Wallet.fromSeed(ISSUER_SEED);
    if (issuer.classicAddress !== ISSUER_ADDRESS) {
      throw new Error(
        `Seed does not match expected issuer address: got ${issuer.classicAddress}`
      );
    }

    console.log(`Issuer: ${issuer.classicAddress}`);

    console.log("Creating and funding holder account on testnet...");
    const { wallet: holder } = await client.fundWallet(null, {
      faucetHost: "faucet.altnet.rippletest.net",
    });
    console.log(`Holder: ${holder.classicAddress}`);

    console.log("Issuing MPT (MPTokenIssuanceCreate, RequireAuth)...");
    const createResult = await submit(client, issuer, {
      TransactionType: "MPTokenIssuanceCreate",
      Account: issuer.classicAddress,
      AssetScale: MPT_ASSET_SCALE,
      MaximumAmount: MPT_TOTAL_SUPPLY,
      TransferFee: 0,
      Flags: tfMPTRequireAuth,
    });

    const createMeta = createResult.result.meta;
    const issuanceId =
      typeof createMeta === "object" && createMeta !== null
        ? (createMeta as { mpt_issuance_id?: string }).mpt_issuance_id
        : undefined;

    if (!issuanceId) {
      throw new Error(
        `Could not find mpt_issuance_id in MPTokenIssuanceCreate metadata: ${JSON.stringify(
          createMeta
        )}`
      );
    }
    console.log(`MPT Issuance ID: ${issuanceId}`);

    console.log("Holder opts in (MPTokenAuthorize)...");
    await submit(client, holder, {
      TransactionType: "MPTokenAuthorize",
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    });

    console.log("Issuer approves holder (MPTokenAuthorize)...");
    await submit(client, issuer, {
      TransactionType: "MPTokenAuthorize",
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    });

    console.log(`Sending ${MPT_SEND_AMOUNT} MPT to holder...`);
    await submit(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: {
        mpt_issuance_id: issuanceId,
        value: MPT_SEND_AMOUNT,
      },
    });

    console.log("Reading balances back from the ledger...");

    const mptokenEntry = await client.request({
      command: "ledger_entry",
      mptoken: {
        mpt_issuance_id: issuanceId,
        account: holder.classicAddress,
      },
      ledger_index: "validated",
    });
    const holderNode = mptokenEntry.result.node as
      | { MPTAmount?: string }
      | undefined;
    const holderBalance = holderNode?.MPTAmount ?? "0";

    const issuanceEntry = await client.request({
      command: "ledger_entry",
      mpt_issuance: issuanceId,
      ledger_index: "validated",
    });
    const issuanceNode = issuanceEntry.result.node as
      | { OutstandingAmount?: string }
      | undefined;
    const outstandingAmount = issuanceNode?.OutstandingAmount;

    if (!outstandingAmount) {
      throw new Error(
        `Could not read OutstandingAmount from MPTokenIssuance ledger entry: ${JSON.stringify(
          issuanceEntry.result
        )}`
      );
    }

    console.log(`Holder balance: ${holderBalance}`);
    console.log(`Outstanding (in circulation): ${outstandingAmount}`);

    const output = {
      issuanceId,
      holder: holder.classicAddress,
      holderBalance,
      outstandingAmount,
    };

    writeFileSync(
      join(__dirname, "..", "result.json"),
      JSON.stringify(output, null, 2) + "\n"
    );
    console.log("Wrote result.json");
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
