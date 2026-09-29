import * as fs from "fs";
import * as path from "path";
import {
  Client,
  Wallet,
  LedgerEntry,
  MPTokenIssuanceCreateFlags,
  type MPTokenIssuanceCreate,
  type MPTokenAuthorize,
  type Payment,
} from "xrpl";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const ISSUER_SEED = "<TESTNET_SEED_REDACTED>";
const MPT_AMOUNT_TO_SEND = "1000";

async function main(): Promise<void> {
  const client = new Client(TESTNET_URL);
  await client.connect();

  try {
    const issuerWallet = Wallet.fromSeed(ISSUER_SEED);
    console.log(`Issuer address: ${issuerWallet.address}`);

    console.log("Funding a new holder account from the testnet faucet...");
    const { wallet: holderWallet } = await client.fundWallet();
    console.log(`Holder address: ${holderWallet.address}`);

    console.log("Issuing new MPT (holders require issuer approval)...");
    const issuanceCreateTx: MPTokenIssuanceCreate = {
      TransactionType: "MPTokenIssuanceCreate",
      Account: issuerWallet.address,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    };

    const issuanceCreateResult = await client.submitAndWait(issuanceCreateTx, {
      wallet: issuerWallet,
    });

    const issuanceMeta = issuanceCreateResult.result.meta;
    if (typeof issuanceMeta !== "object" || issuanceMeta === null) {
      throw new Error("MPTokenIssuanceCreate did not return transaction metadata.");
    }
    const issuanceId = (issuanceMeta as { mpt_issuance_id?: string }).mpt_issuance_id;
    if (!issuanceId) {
      throw new Error("MPTokenIssuanceCreate result did not include an mpt_issuance_id.");
    }
    console.log(`MPT issuance ID: ${issuanceId}`);

    console.log("Holder opting in to the MPT (MPTokenAuthorize, no Holder field)...");
    const holderOptInTx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: holderWallet.address,
      MPTokenIssuanceID: issuanceId,
    };
    await client.submitAndWait(holderOptInTx, { wallet: holderWallet });

    console.log("Issuer approving the holder (MPTokenAuthorize with Holder field)...");
    const issuerAuthorizeTx: MPTokenAuthorize = {
      TransactionType: "MPTokenAuthorize",
      Account: issuerWallet.address,
      MPTokenIssuanceID: issuanceId,
      Holder: holderWallet.address,
    };
    await client.submitAndWait(issuerAuthorizeTx, { wallet: issuerWallet });

    console.log(`Sending ${MPT_AMOUNT_TO_SEND} of the MPT to the holder...`);
    const paymentTx: Payment = {
      TransactionType: "Payment",
      Account: issuerWallet.address,
      Destination: holderWallet.address,
      Amount: {
        mpt_issuance_id: issuanceId,
        value: MPT_AMOUNT_TO_SEND,
      },
    };
    await client.submitAndWait(paymentTx, { wallet: issuerWallet });

    console.log("Reading balances back from the ledger...");
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
    const issuanceEntry = issuanceResponse.result.node as unknown as LedgerEntry.MPTokenIssuance;
    const outstandingAmount = issuanceEntry.OutstandingAmount;

    console.log(`Holder balance: ${holderBalance}`);
    console.log(`Outstanding (total in circulation): ${outstandingAmount}`);

    const result = {
      issuanceId,
      holder: holderWallet.address,
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
