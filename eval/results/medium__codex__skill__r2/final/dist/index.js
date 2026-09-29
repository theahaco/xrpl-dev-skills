import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { Client, Wallet, xrpToDrops, } from 'xrpl';
import { createIssuance, tokenPayment } from './transactions.js';
const ENDPOINT = 'wss://s.altnet.rippletest.net:51233';
const ISSUER = 'r4qjkCwSs5LcYLNuDHL9C7mGdMHcg37z36';
const client = new Client(ENDPOINT);
async function submit(transaction, wallet) {
    // Autofill supplies the current sequence, fee, and bounded LastLedgerSequence.
    for (let attempt = 0; attempt < 2; attempt++) {
        const prepared = await client.autofill(transaction);
        if (!prepared.LastLedgerSequence)
            throw new Error('Missing LastLedgerSequence');
        const signed = wallet.sign(prepared);
        // Persist the hash before submitting so an interrupted run can be investigated.
        await appendFile('transactions.jsonl', JSON.stringify({
            stage: 'prepared', hash: signed.hash, transaction: prepared,
        }) + '\n');
        try {
            // submitAndWait handles queued transactions by polling until validation/expiry.
            const response = await client.submitAndWait(signed.tx_blob);
            const { validated, meta } = response.result;
            if (!validated || !meta || typeof meta === 'string') {
                throw new Error(`Missing validated metadata for ${signed.hash}`);
            }
            await appendFile('transactions.jsonl', JSON.stringify({
                stage: 'validated', hash: signed.hash, result: response.result,
            }) + '\n');
            if (meta.TransactionResult !== 'tesSUCCESS') {
                // tec failures consumed a fee; don't blindly retry them.
                throw new Error(`${signed.hash}: ${meta.TransactionResult}`);
            }
            console.log(`${transaction.TransactionType}: validated ${signed.hash}`);
            return meta;
        }
        catch (error) {
            // A past sequence is definitely rejected; refresh it once. Do not retry
            // ambiguous network failures, which could duplicate an already applied payment.
            if (attempt === 0 && error instanceof Error && error.message.includes('tefPAST_SEQ'))
                continue;
            throw error;
        }
    }
    throw new Error('Sequence retry exhausted');
}
async function readBalances(issuanceId, holder) {
    const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
    const ledgerHash = ledger.result.ledger_hash;
    const [issuanceResponse, holderResponse] = await Promise.all([
        client.request({ command: 'ledger_entry', mpt_issuance: issuanceId, ledger_hash: ledgerHash }),
        client.request({
            command: 'ledger_entry', mptoken: { mpt_issuance_id: issuanceId, account: holder },
            ledger_hash: ledgerHash,
        }),
    ]);
    const issuance = issuanceResponse.result.node;
    // xrpl 5.3's LedgerEntry union omits MPToken; validate its shape at runtime.
    const holding = holderResponse.result.node;
    if (!issuanceResponse.result.validated || !holderResponse.result.validated ||
        issuance.LedgerEntryType !== 'MPTokenIssuance' ||
        !holding || typeof holding !== 'object' ||
        !('LedgerEntryType' in holding) || holding.LedgerEntryType !== 'MPToken' ||
        !('Flags' in holding) || typeof holding.Flags !== 'number' ||
        !('MPTokenIssuanceID' in holding) || !('MPTAmount' in holding) ||
        typeof holding.MPTAmount !== 'string') {
        throw new Error('Expected validated MPT ledger entries');
    }
    if (issuance.Issuer !== ISSUER ||
        !(issuance.Flags & 0x00000004) || // lsfMPTRequireAuth
        !(holding.Flags & 0x00000002) || holding.MPTokenIssuanceID !== issuanceId) {
        throw new Error('Issuer, RequireAuth, or holder authorization verification failed');
    }
    const result = {
        issuanceId, holder,
        holderBalance: holding.MPTAmount,
        outstandingAmount: issuance.OutstandingAmount,
    };
    if (result.holderBalance !== '1000' || result.outstandingAmount !== '1000') {
        throw new Error(`Unexpected ledger balances: ${JSON.stringify(result)}`);
    }
    await writeFile('ledger-proof.json', JSON.stringify({
        endpoint: ENDPOINT, ledgerHash, issuance: issuanceResponse.result, holder: holderResponse.result,
    }, null, 2) + '\n');
    await writeFile('result.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
}
async function main() {
    await client.connect();
    try {
        const server = await client.request({ command: 'server_info' });
        if (server.result.info.network_id !== 1)
            throw new Error('Expected XRPL testnet (network 1)');
        if (process.argv.includes('--verify')) {
            const saved = JSON.parse(await readFile('result.json', 'utf8'));
            if (!saved || typeof saved !== 'object' || !('issuanceId' in saved) ||
                !('holder' in saved) || typeof saved.issuanceId !== 'string' || typeof saved.holder !== 'string') {
                throw new Error('Invalid result.json');
            }
            await readBalances(saved.issuanceId, saved.holder);
            return;
        }
        const seed = process.env.XRPL_ISSUER_SEED;
        if (!seed)
            throw new Error('Set XRPL_ISSUER_SEED to your testnet issuer seed');
        const issuer = Wallet.fromSeed(seed);
        if (issuer.classicAddress !== ISSUER)
            throw new Error('Seed does not match the expected issuer');
        const reserve = server.result.info.validated_ledger;
        if (!reserve)
            throw new Error('Missing reserve information');
        console.log(`Testnet reserves: base ${reserve.reserve_base_xrp} XRP; per object ${reserve.reserve_inc_xrp} XRP`);
        const fundingXrp = Math.max(5, reserve.reserve_base_xrp + reserve.reserve_inc_xrp + 1);
        const account = await client.request({ command: 'account_info', account: ISSUER, ledger_index: 'validated' });
        const requiredXrp = fundingXrp + reserve.reserve_base_xrp +
            (account.result.account_data.OwnerCount + 1) * reserve.reserve_inc_xrp + 1;
        if (BigInt(account.result.account_data.Balance) < BigInt(xrpToDrops(requiredXrp))) {
            throw new Error('Insufficient issuer XRP for funding, reserves, and fees');
        }
        // Refuse a second issuance after an interrupted/successful run. Read-only
        // verification is always available; inspect the journal before starting afresh.
        await writeFile('.run-started', new Date().toISOString() + '\n', { flag: 'wx', mode: 0o600 });
        const holder = Wallet.generate();
        await writeFile('.holder.json', JSON.stringify({
            address: holder.classicAddress, seed: holder.seed,
        }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        const meta = await submit(createIssuance(ISSUER), issuer);
        if (!('mpt_issuance_id' in meta) || typeof meta.mpt_issuance_id !== 'string') {
            throw new Error('Validated creation metadata is missing mpt_issuance_id; inspect transactions.jsonl');
        }
        const issuanceId = meta.mpt_issuance_id;
        await submit({ TransactionType: 'Payment', Account: ISSUER,
            Destination: holder.classicAddress, Amount: xrpToDrops(fundingXrp) }, issuer);
        // The holder first creates its MPToken entry; the issuer then allow-lists it.
        await submit({ TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress,
            MPTokenIssuanceID: issuanceId }, holder);
        await submit({ TransactionType: 'MPTokenAuthorize', Account: ISSUER,
            MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress }, issuer);
        await submit(tokenPayment(ISSUER, holder.classicAddress, issuanceId), issuer);
        await readBalances(issuanceId, holder.classicAddress);
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
