"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const xrpl_1 = require("xrpl");
const TESTNET_WEBSOCKET_URL = 'wss://s.altnet.rippletest.net:51233';
const ISSUER_SEED = '<TESTNET_SEED_REDACTED>';
const MPT_TRANSFER_AMOUNT = '1000';
function requireSuccess(response, label) {
    const { meta } = response.result;
    if (meta == null || typeof meta === 'string') {
        throw new Error(`${label}: transaction metadata unavailable`);
    }
    if (meta.TransactionResult !== 'tesSUCCESS') {
        throw new Error(`${label} failed: ${meta.TransactionResult}`);
    }
}
async function fetchMptIssuance(client, issuanceId) {
    const response = await client.request({
        command: 'ledger_entry',
        mpt_issuance: issuanceId,
        ledger_index: 'validated',
    });
    const { node } = response.result;
    if (node.LedgerEntryType !== 'MPTokenIssuance') {
        throw new Error('ledger_entry did not return an MPTokenIssuance entry');
    }
    return node;
}
async function fetchMptokenBalance(client, issuanceId, account) {
    const response = await client.request({
        command: 'ledger_entry',
        mptoken: { mpt_issuance_id: issuanceId, account },
        ledger_index: 'validated',
    });
    const node = response.result.node;
    if (node.LedgerEntryType !== 'MPToken') {
        throw new Error('ledger_entry did not return an MPToken entry');
    }
    return node.MPTAmount;
}
async function main() {
    const client = new xrpl_1.Client(TESTNET_WEBSOCKET_URL);
    await client.connect();
    try {
        const issuer = xrpl_1.Wallet.fromSeed(ISSUER_SEED);
        console.log(`Issuer:  ${issuer.address}`);
        const { wallet: holder } = await client.fundWallet(null, {
            usageContext: 'xrpl-mpt-demo',
        });
        console.log(`Holder:  ${holder.address}`);
        // 1. Issue a new MPT. tfMPTRequireAuth means only holders the issuer
        // explicitly approves are allowed to hold it (allow-listing).
        const issuanceCreateTx = {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: issuer.address,
            Flags: { tfMPTRequireAuth: true },
        };
        const issuanceResponse = await client.submitAndWait(issuanceCreateTx, {
            wallet: issuer,
        });
        requireSuccess(issuanceResponse, 'MPTokenIssuanceCreate');
        const { meta: issuanceMeta } = issuanceResponse.result;
        const issuanceId = typeof issuanceMeta === 'object' ? issuanceMeta.mpt_issuance_id : undefined;
        if (issuanceId == null) {
            throw new Error('MPTokenIssuanceCreate did not return an mpt_issuance_id');
        }
        console.log(`Issued MPT: ${issuanceId}`);
        // 2. The holder opts in (creating their MPToken entry), then the issuer
        // approves that holder. Both steps are required when tfMPTRequireAuth is set.
        const holderOptInTx = {
            TransactionType: 'MPTokenAuthorize',
            Account: holder.address,
            MPTokenIssuanceID: issuanceId,
        };
        requireSuccess(await client.submitAndWait(holderOptInTx, { wallet: holder }), 'MPTokenAuthorize (holder opt-in)');
        const issuerApproveTx = {
            TransactionType: 'MPTokenAuthorize',
            Account: issuer.address,
            MPTokenIssuanceID: issuanceId,
            Holder: holder.address,
        };
        requireSuccess(await client.submitAndWait(issuerApproveTx, { wallet: issuer }), 'MPTokenAuthorize (issuer approval)');
        console.log(`Approved holder: ${holder.address}`);
        // 3. Send the holder 1,000 of the token.
        const paymentTx = {
            TransactionType: 'Payment',
            Account: issuer.address,
            Destination: holder.address,
            Amount: { mpt_issuance_id: issuanceId, value: MPT_TRANSFER_AMOUNT },
        };
        requireSuccess(await client.submitAndWait(paymentTx, { wallet: issuer }), 'Payment');
        console.log(`Sent ${MPT_TRANSFER_AMOUNT} MPT to ${holder.address}`);
        // 4. Read the balances back from the ledger.
        const holderBalance = await fetchMptokenBalance(client, issuanceId, holder.address);
        const issuance = await fetchMptIssuance(client, issuanceId);
        const outstandingAmount = issuance.OutstandingAmount;
        console.log(`Holder balance:      ${holderBalance}`);
        console.log(`Outstanding amount:  ${outstandingAmount}`);
        const result = {
            issuanceId,
            holder: holder.address,
            holderBalance,
            outstandingAmount,
        };
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(__dirname, '..', 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
        console.log('Wrote result.json');
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
