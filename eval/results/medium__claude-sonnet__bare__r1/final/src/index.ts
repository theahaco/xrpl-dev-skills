import * as fs from "fs";
import * as path from "path";
import {
  Client,
  Wallet,
  TxResponse,
  MPTokenIssuanceCreate,
  MPTokenAuthorize,
  Payment,
  LedgerEntry,
} from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";

const ISSUER_SEED = "<TESTNET_SEED_REDACTED>";
const ISSUER_ADDRESS = "rEdNPzUSS1F2huoSYuj4BvtWJYKJEuGMBF";

const HOLDER_TOKEN_AMOUNT = "1000";

interface Result {
  issuanceId: string;
  holder: string;
  holderBalance: string;
  outstandingAmount: string;
}

function assertTesSuccess(response: TxResponse, label: string): void {
  const meta = response.result.meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new Error(`${label}: missing transaction metadata`);
  }
  const transactionResult = (meta as { TransactionResult?: string }).TransactionResult;
  if (transactionResult !== "tesSUCCESS") {
    throw new Error(`${label}: transaction failed with result ${String(transactionResult)}`);
  }
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_URL);
  await client.connect();

  try {
    const issuer = Wallet.fromSeed(ISSUER_SEED);
    if (issuer.classicAddress !== ISSUER_ADDRESS) {
      throw new Error(
        `Derived issuer address ${issuer.classicAddress} does not match expected ${ISSUER_ADDRESS}`
      );
    }
    console.log(`Issuer account: ${issuer.classicAddress}`);

    console.log("Funding a new holder account from the testnet faucet...");
    const { wallet: holder } = await client.fundWallet();
    console.log(`Holder account: ${holder.classicAddress}`);

    console.log("Issuing a new MPT that requires holder authorization...");
    const issuanceCreateTx: MPTokenIssuanceCreate = {
      TransactionType: "MPTokenIssuanceCreate",
      Account: issuer.classicAddress,
      AssetScale: 0,
      MaximumAmount: "1000000000",
      Flags: {
        tfMPTRequireAuth: true,
        tfMPTCanTransfer: true,
      },
    };
    const issuanceCreateResponse = await client.submitAndWait(issuanceCreateTx, {
      wallet: issuer,
    });
    assertTesSuccess(issuanceCreateResponse, "MPTokenIssuanceCreate");

    const issuanceMeta = issuanceCreateResponse.result.meta as {
      mpt_issuance_id?: string;
    };
    const issuanceId = issuanceMeta.mpt_issuance_id;
    if (!issuanceId) {
      throw new Error("MPTokenIssuanceCreate did not return an mpt_issuance_id");
    }
    console.log(`MPT issuance ID: ${issuanceId}`);

    console.log("Holder opts in to the MPT (creates its MPToken object)...");
    const holderOptInTx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    };
    const holderOptInResponse = await client.submitAndWait(holderOptInTx, {
      wallet: holder,
    });
    assertTesSuccess(holderOptInResponse, "MPTokenAuthorize (holder opt-in)");

    console.log("Issuer approves the holder to hold the MPT...");
    const issuerAuthorizeTx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    };
    const issuerAuthorizeResponse = await client.submitAndWait(issuerAuthorizeTx, {
      wallet: issuer,
    });
    assertTesSuccess(issuerAuthorizeResponse, "MPTokenAuthorize (issuer approval)");

    console.log(`Sending ${HOLDER_TOKEN_AMOUNT} of the MPT to the holder...`);
    const paymentTx: Payment = {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: {
        mpt_issuance_id: issuanceId,
        value: HOLDER_TOKEN_AMOUNT,
      },
    };
    const paymentResponse = await client.submitAndWait(paymentTx, { wallet: issuer });
    assertTesSuccess(paymentResponse, "Payment");

    console.log("Reading balances back from the ledger...");
    const mptokenEntry = await client.request({
      command: "ledger_entry",
      mptoken: {
        mpt_issuance_id: issuanceId,
        account: holder.classicAddress,
      },
      ledger_index: "validated",
    });
    const holderBalance = (
      mptokenEntry.result.node as unknown as LedgerEntry.MPToken
    ).MPTAmount;

    const issuanceEntry = await client.request({
      command: "ledger_entry",
      mpt_issuance: issuanceId,
      ledger_index: "validated",
    });
    const outstandingAmount = (
      issuanceEntry.result.node as unknown as LedgerEntry.MPTokenIssuance
    ).OutstandingAmount;

    console.log(`Holder balance: ${holderBalance}`);
    console.log(`Outstanding amount (total in circulation): ${outstandingAmount}`);

    const result: Result = {
      issuanceId,
      holder: holder.classicAddress,
      holderBalance,
      outstandingAmount,
    };

    const resultPath = path.join(__dirname, "..", "result.json");
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
    console.log(`Wrote ${resultPath}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
