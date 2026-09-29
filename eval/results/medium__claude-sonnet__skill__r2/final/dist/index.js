"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const xrpl_1 = require("xrpl");
const TESTNET_WSS = "wss://s.altnet.rippletest.net:51233";
const ISSUER_SEED = "<TESTNET_SEED_REDACTED>";
const ISSUER_ADDRESS = "rfF4zEtt8FSyWPLwu8i3rdRNgPMTjbFYfg";
const MPT_MAXIMUM_AMOUNT = "1000000000";
const MPT_ASSET_SCALE = 0;
const AMOUNT_TO_SEND = "1000";
async function submit(client, wallet, transaction, label) {
    const prepared = await client.autofill(transaction);
    const signed = wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    const txResult = result.result.meta && typeof result.result.meta !== "string"
        ? result.result.meta.TransactionResult
        : undefined;
    if (txResult !== "tesSUCCESS") {
        throw new Error(`${label} failed with result: ${txResult ?? "unknown"} (hash: ${signed.hash})`);
    }
    console.log(`${label}: tesSUCCESS (hash: ${signed.hash})`);
    return result;
}
async function main() {
    const client = new xrpl_1.Client(TESTNET_WSS);
    await client.connect();
    try {
        const issuerWallet = xrpl_1.Wallet.fromSeed(ISSUER_SEED);
        if (issuerWallet.address !== ISSUER_ADDRESS) {
            throw new Error(`Derived address ${issuerWallet.address} does not match expected ${ISSUER_ADDRESS}`);
        }
        console.log(`Issuer: ${issuerWallet.address}`);
        console.log("Funding a new holder account from the testnet faucet...");
        const { wallet: holderWallet } = await client.fundWallet();
        console.log(`Holder: ${holderWallet.address}`);
        // 1. Issue a new MPT that requires issuer authorization for holders.
        const mptCreateTx = {
            TransactionType: "MPTokenIssuanceCreate",
            Account: issuerWallet.address,
            MaximumAmount: MPT_MAXIMUM_AMOUNT,
            AssetScale: MPT_ASSET_SCALE,
            Flags: xrpl_1.MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
        };
        const createResult = await submit(client, issuerWallet, mptCreateTx, "MPTokenIssuanceCreate");
        const issuanceId = createResult.result.meta &&
            typeof createResult.result.meta !== "string"
            ? createResult.result.meta.mpt_issuance_id
            : undefined;
        if (!issuanceId) {
            throw new Error("MPTokenIssuanceCreate did not return an mpt_issuance_id");
        }
        console.log(`Issuance ID: ${issuanceId}`);
        // 2a. Holder opts in to the MPT.
        const holderOptInTx = {
            TransactionType: "MPTokenAuthorize",
            Account: holderWallet.address,
            MPTokenIssuanceID: issuanceId,
        };
        await submit(client, holderWallet, holderOptInTx, "MPTokenAuthorize (holder opt-in)");
        // 2b. Issuer approves the holder (required because tfMPTRequireAuth is set).
        const issuerAuthTx = {
            TransactionType: "MPTokenAuthorize",
            Account: issuerWallet.address,
            MPTokenIssuanceID: issuanceId,
            Holder: holderWallet.address,
        };
        await submit(client, issuerWallet, issuerAuthTx, "MPTokenAuthorize (issuer approval)");
        // 3. Send the holder 1,000 of the token.
        const paymentTx = {
            TransactionType: "Payment",
            Account: issuerWallet.address,
            Destination: holderWallet.address,
            Amount: {
                mpt_issuance_id: issuanceId,
                value: AMOUNT_TO_SEND,
            },
        };
        await submit(client, issuerWallet, paymentTx, "Payment (issue 1000 MPT to holder)");
        // 4. Read balances back from the ledger.
        const mptokenEntry = await client.request({
            command: "ledger_entry",
            mptoken: {
                mpt_issuance_id: issuanceId,
                account: holderWallet.address,
            },
            ledger_index: "validated",
        });
        const holderBalance = mptokenEntry.result.node
            .MPTAmount;
        const issuanceEntry = await client.request({
            command: "ledger_entry",
            mpt_issuance: issuanceId,
            ledger_index: "validated",
        });
        const outstandingAmount = issuanceEntry.result.node
            .OutstandingAmount;
        console.log(`Holder balance: ${holderBalance}`);
        console.log(`Outstanding amount (total in circulation): ${outstandingAmount}`);
        const result = {
            issuanceId,
            holder: holderWallet.address,
            holderBalance,
            outstandingAmount,
        };
        const resultPath = node_path_1.default.join(__dirname, "..", "result.json");
        (0, node_fs_1.writeFileSync)(resultPath, JSON.stringify(result, null, 2) + "\n");
        console.log(`Wrote ${resultPath}`);
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
