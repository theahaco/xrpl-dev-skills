"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const xrpl_1 = require("xrpl");
const TESTNET_WS = 'wss://s.altnet.rippletest.net:51233';
const ISSUER_SEED = '<TESTNET_SEED_REDACTED>';
const HOLDER_FUNDING_XRP = '20';
const MPT_AMOUNT_TO_SEND = '1000';
async function main() {
    const client = new xrpl_1.Client(TESTNET_WS);
    await client.connect();
    try {
        const issuer = xrpl_1.Wallet.fromSeed(ISSUER_SEED);
        const holder = xrpl_1.Wallet.generate();
        console.log(`Issuer:  ${issuer.address}`);
        console.log(`Holder:  ${holder.address}`);
        // Fund the holder account from the issuer so it exists on the ledger.
        const fundTx = {
            TransactionType: 'Payment',
            Account: issuer.address,
            Destination: holder.address,
            Amount: (0, xrpl_1.xrpToDrops)(HOLDER_FUNDING_XRP),
        };
        await submit(client, issuer, fundTx, 'Fund holder account');
        // 1. Issue a new MPT. tfMPTRequireAuth restricts holding to
        // accounts the issuer explicitly authorizes.
        const issuanceCreateTx = {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: issuer.address,
            AssetScale: 0,
            MaximumAmount: '1000000000',
            Flags: {
                tfMPTRequireAuth: true,
            },
        };
        const issuanceResult = await submit(client, issuer, issuanceCreateTx, 'Create MPT issuance');
        const issuanceId = issuanceResult.result.meta && typeof issuanceResult.result.meta === 'object'
            ? issuanceResult.result.meta.mpt_issuance_id
            : undefined;
        if (!issuanceId) {
            throw new Error('MPTokenIssuanceCreate did not return an mpt_issuance_id');
        }
        console.log(`Issuance ID: ${issuanceId}`);
        // 2a. Holder opts in to holding this MPT.
        const holderOptInTx = {
            TransactionType: 'MPTokenAuthorize',
            Account: holder.address,
            MPTokenIssuanceID: issuanceId,
        };
        await submit(client, holder, holderOptInTx, 'Holder opts in to MPT');
        // 2b. Issuer approves the holder (required because tfMPTRequireAuth is set).
        const issuerAuthorizeTx = {
            TransactionType: 'MPTokenAuthorize',
            Account: issuer.address,
            MPTokenIssuanceID: issuanceId,
            Holder: holder.address,
        };
        await submit(client, issuer, issuerAuthorizeTx, 'Issuer authorizes holder');
        // 3. Send the holder 1,000 of the token.
        const paymentTx = {
            TransactionType: 'Payment',
            Account: issuer.address,
            Destination: holder.address,
            Amount: {
                mpt_issuance_id: issuanceId,
                value: MPT_AMOUNT_TO_SEND,
            },
        };
        await submit(client, issuer, paymentTx, `Send ${MPT_AMOUNT_TO_SEND} MPT to holder`);
        // 4. Read balances back from the ledger.
        const mptokenResponse = await client.request({
            command: 'ledger_entry',
            mptoken: {
                mpt_issuance_id: issuanceId,
                account: holder.address,
            },
            ledger_index: 'validated',
        });
        const holderBalance = mptokenResponse.result.node.MPTAmount;
        const issuanceResponse = await client.request({
            command: 'ledger_entry',
            mpt_issuance: issuanceId,
            ledger_index: 'validated',
        });
        const outstandingAmount = issuanceResponse.result.node
            .OutstandingAmount;
        console.log(`Holder balance:      ${holderBalance}`);
        console.log(`Outstanding amount:  ${outstandingAmount}`);
        const result = {
            issuanceId,
            holder: holder.address,
            holderBalance,
            outstandingAmount,
        };
        (0, node_fs_1.writeFileSync)(node_path_1.default.join(__dirname, '..', 'result.json'), JSON.stringify(result, null, 2) + '\n');
        console.log('Wrote result.json');
    }
    finally {
        await client.disconnect();
    }
}
async function submit(client, wallet, transaction, label) {
    const prepared = await client.autofill(transaction);
    const signed = wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    const meta = result.result.meta;
    const transactionResult = meta && typeof meta === 'object' ? meta.TransactionResult : undefined;
    if (transactionResult !== 'tesSUCCESS') {
        throw new Error(`${label} failed: ${transactionResult ?? 'unknown result'}`);
    }
    console.log(`${label}: ${transactionResult} (${result.result.hash})`);
    return result;
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
