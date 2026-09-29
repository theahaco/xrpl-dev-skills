"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const xrpl_1 = require("xrpl");
const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const ISSUER_SEED = "<TESTNET_SEED_REDACTED>";
const MPT_AMOUNT_TO_SEND = "1000";
async function main() {
    const client = new xrpl_1.Client(TESTNET_URL);
    await client.connect();
    try {
        const issuerWallet = xrpl_1.Wallet.fromSeed(ISSUER_SEED);
        console.log(`Issuer address: ${issuerWallet.address}`);
        console.log("Funding a new holder account from the testnet faucet...");
        const { wallet: holderWallet } = await client.fundWallet();
        console.log(`Holder address: ${holderWallet.address}`);
        console.log("Issuing new MPT (holders require issuer approval)...");
        const issuanceCreateTx = {
            TransactionType: "MPTokenIssuanceCreate",
            Account: issuerWallet.address,
            Flags: xrpl_1.MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
        };
        const issuanceCreateResult = await client.submitAndWait(issuanceCreateTx, {
            wallet: issuerWallet,
        });
        const issuanceMeta = issuanceCreateResult.result.meta;
        if (typeof issuanceMeta !== "object" || issuanceMeta === null) {
            throw new Error("MPTokenIssuanceCreate did not return transaction metadata.");
        }
        const issuanceId = issuanceMeta.mpt_issuance_id;
        if (!issuanceId) {
            throw new Error("MPTokenIssuanceCreate result did not include an mpt_issuance_id.");
        }
        console.log(`MPT issuance ID: ${issuanceId}`);
        console.log("Holder opting in to the MPT (MPTokenAuthorize, no Holder field)...");
        const holderOptInTx = {
            TransactionType: "MPTokenAuthorize",
            Account: holderWallet.address,
            MPTokenIssuanceID: issuanceId,
        };
        await client.submitAndWait(holderOptInTx, { wallet: holderWallet });
        console.log("Issuer approving the holder (MPTokenAuthorize with Holder field)...");
        const issuerAuthorizeTx = {
            TransactionType: "MPTokenAuthorize",
            Account: issuerWallet.address,
            MPTokenIssuanceID: issuanceId,
            Holder: holderWallet.address,
        };
        await client.submitAndWait(issuerAuthorizeTx, { wallet: issuerWallet });
        console.log(`Sending ${MPT_AMOUNT_TO_SEND} of the MPT to the holder...`);
        const paymentTx = {
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
        const holderMPToken = mptokenResponse.result.node;
        const holderBalance = holderMPToken.MPTAmount;
        const issuanceResponse = await client.request({
            command: "ledger_entry",
            mpt_issuance: issuanceId,
        });
        const issuanceEntry = issuanceResponse.result.node;
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
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
