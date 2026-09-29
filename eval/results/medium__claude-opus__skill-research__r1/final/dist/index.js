import { writeFile } from 'node:fs/promises';
import { Client, MPTokenIssuanceCreateFlags, DEFAULT_API_VERSION, Wallet, xrpToDrops, } from 'xrpl';
const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233';
// Enough to cover the 1 XRP base reserve, the 0.2 XRP MPToken owner reserve, and fees.
const HOLDER_FUNDING_XRP = '3';
const AMOUNT_TO_SEND = '1000';
// MPToken ledger flag set once the issuer has authorized the holder.
const LSF_MPT_AUTHORIZED = 0x00000002;
async function submit(client, wallet, tx) {
    const response = await client.submitAndWait(tx, { wallet, autofill: true });
    const meta = response.result.meta;
    if (typeof meta !== 'object') {
        throw new Error(`${tx.TransactionType}: missing metadata`);
    }
    if (meta.TransactionResult !== 'tesSUCCESS') {
        throw new Error(`${tx.TransactionType} failed: ${meta.TransactionResult}`);
    }
    console.log(`  ${tx.TransactionType} validated: ${response.result.hash}`);
    return meta;
}
// Typed ledger_entry lookup. Needed because xrpl.js's LedgerEntry union does
// not include MPToken, so the default response type can't be narrowed to it.
async function getLedgerEntry(client, request) {
    const response = await client.request({ command: 'ledger_entry', ledger_index: 'validated', ...request });
    return response.result.node ?? {};
}
async function main() {
    const issuerSeed = process.env['ISSUER_SEED'];
    if (issuerSeed === undefined || issuerSeed === '') {
        throw new Error('Set ISSUER_SEED (e.g. in .env) to the issuer account seed');
    }
    const client = new Client(TESTNET_URL);
    await client.connect();
    try {
        const issuer = Wallet.fromSeed(issuerSeed);
        console.log(`Issuer: ${issuer.classicAddress}`);
        // 1. Create the issuance. tfMPTRequireAuth means only holders the issuer
        //    has explicitly authorized can hold the token.
        console.log('Creating MPT issuance...');
        const create = {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: issuer.classicAddress,
            Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
            AssetScale: 0,
        };
        const createMeta = await submit(client, issuer, create);
        const issuanceId = 'mpt_issuance_id' in createMeta ? createMeta.mpt_issuance_id : undefined;
        if (typeof issuanceId !== 'string') {
            throw new Error('MPTokenIssuanceCreate metadata has no mpt_issuance_id');
        }
        console.log(`  Issuance ID: ${issuanceId}`);
        // 2. Create and fund the holder account from the issuer.
        const holder = Wallet.generate();
        console.log(`Funding holder ${holder.classicAddress}...`);
        const fund = {
            TransactionType: 'Payment',
            Account: issuer.classicAddress,
            Destination: holder.classicAddress,
            Amount: xrpToDrops(HOLDER_FUNDING_XRP),
        };
        await submit(client, issuer, fund);
        // 3. The holder opts in (creates its MPToken entry)...
        console.log('Holder opting in to the MPT...');
        const optIn = {
            TransactionType: 'MPTokenAuthorize',
            Account: holder.classicAddress,
            MPTokenIssuanceID: issuanceId,
        };
        await submit(client, holder, optIn);
        // ...and the issuer approves the holder.
        console.log('Issuer authorizing the holder...');
        const approve = {
            TransactionType: 'MPTokenAuthorize',
            Account: issuer.classicAddress,
            MPTokenIssuanceID: issuanceId,
            Holder: holder.classicAddress,
        };
        await submit(client, issuer, approve);
        // 4. Issue 1,000 tokens to the holder.
        console.log(`Sending ${AMOUNT_TO_SEND} MPT to the holder...`);
        const amount = {
            mpt_issuance_id: issuanceId,
            value: AMOUNT_TO_SEND,
        };
        const send = {
            TransactionType: 'Payment',
            Account: issuer.classicAddress,
            Destination: holder.classicAddress,
            Amount: amount,
        };
        await submit(client, issuer, send);
        // 5. Read the balances back from the validated ledger.
        const token = await getLedgerEntry(client, {
            mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
        });
        if (token.LedgerEntryType !== 'MPToken') {
            throw new Error('Holder MPToken entry not found');
        }
        if (((token.Flags ?? 0) & LSF_MPT_AUTHORIZED) === 0) {
            throw new Error('Holder MPToken entry is not authorized by the issuer');
        }
        const issuance = await getLedgerEntry(client, { mpt_issuance: issuanceId });
        if (issuance.LedgerEntryType !== 'MPTokenIssuance') {
            throw new Error('MPTokenIssuance entry not found');
        }
        // Both amount fields are omitted from the ledger entry when they are zero.
        const result = {
            issuanceId,
            holder: holder.classicAddress,
            holderBalance: token.MPTAmount ?? '0',
            outstandingAmount: issuance.OutstandingAmount ?? '0',
        };
        console.log(`\nHolder balance:     ${result.holderBalance}`);
        console.log(`Outstanding amount: ${result.outstandingAmount}`);
        console.log(`Holder seed (testnet only): ${holder.seed ?? '(none)'}`);
        await writeFile(new URL('../result.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
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
