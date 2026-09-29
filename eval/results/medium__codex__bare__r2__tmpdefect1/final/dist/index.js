import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { Client, Wallet, MPTokenIssuanceCreateFlags, xrpToDrops, } from 'xrpl';
if (existsSync('.env'))
    loadEnvFile('.env');
const ISSUER = 'rfZ1QE8owabXA94HYuKpqZHzRULCGgx16y';
const client = new Client('wss://s.altnet.rippletest.net:51233');
const receipts = [];
async function submit(transaction, wallet) {
    const response = await client.submitAndWait(transaction, { wallet, autofill: true });
    receipts.push(response.result);
    await writeFile('transactions.json', JSON.stringify(receipts, null, 2) + '\n');
    const { meta, validated, hash } = response.result;
    if (!validated || !meta || typeof meta === 'string' || meta.TransactionResult !== 'tesSUCCESS') {
        throw new Error(`Transaction did not validate successfully: ${hash}`);
    }
    console.log(`${transaction.TransactionType}: ${hash} (validated tesSUCCESS)`);
    return meta;
}
async function readBalances(issuanceId, holder) {
    // Pin both reads to the same validated ledger snapshot.
    const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
    const ledger_hash = ledger.result.ledger_hash;
    const [holdingResponse, issuanceResponse] = await Promise.all([
        client.request({ command: 'ledger_entry', ledger_hash,
            mptoken: { mpt_issuance_id: issuanceId, account: holder } }),
        client.request({ command: 'ledger_entry', ledger_hash, mpt_issuance: issuanceId }),
    ]);
    const holding = holdingResponse.result.node;
    const issuance = issuanceResponse.result.node;
    if (!holdingResponse.result.validated || !issuanceResponse.result.validated ||
        !holding || typeof holding !== 'object' ||
        !('LedgerEntryType' in holding) || holding.LedgerEntryType !== 'MPToken' ||
        !('Flags' in holding) || typeof holding.Flags !== 'number' ||
        !('MPTAmount' in holding) || typeof holding.MPTAmount !== 'string' ||
        issuance.LedgerEntryType !== 'MPTokenIssuance') {
        throw new Error('Expected validated MPT ledger entries');
    }
    if (issuance.Issuer !== ISSUER ||
        !(issuance.Flags & MPTokenIssuanceCreateFlags.tfMPTRequireAuth) ||
        !(holding.Flags & 2)) { // lsfMPTAuthorized
        throw new Error('Issuer, RequireAuth, or holder authorization verification failed');
    }
    const result = { issuanceId, holder, holderBalance: holding.MPTAmount,
        outstandingAmount: issuance.OutstandingAmount };
    if (result.holderBalance !== '1000' || result.outstandingAmount !== '1000') {
        throw new Error(`Unexpected ledger amounts: ${JSON.stringify(result)}`);
    }
    await writeFile('ledger-evidence.json', JSON.stringify({ ledgerHash: ledger_hash,
        ledgerIndex: ledger.result.ledger_index, holding: holdingResponse.result,
        issuance: issuanceResponse.result }, null, 2) + '\n');
    await writeFile('result.json', JSON.stringify(result, null, 2) + '\n');
    console.log(`Holder balance: ${result.holderBalance}`);
    console.log(`Total in circulation: ${result.outstandingAmount}`);
}
async function main() {
    await client.connect();
    try {
        // Once completed, repeated runs only re-read the ledger; no duplicate minting.
        if (existsSync('result.json')) {
            const previous = JSON.parse(await readFile('result.json', 'utf8'));
            if (!previous || typeof previous !== 'object' || !('issuanceId' in previous) ||
                !('holder' in previous) || typeof previous.issuanceId !== 'string' ||
                typeof previous.holder !== 'string')
                throw new Error('Invalid result.json');
            await readBalances(previous.issuanceId, previous.holder);
            return;
        }
        if (existsSync('.run-started')) {
            throw new Error('An earlier run started. Inspect transactions.json and ledger state before retrying.');
        }
        const seed = process.env.ISSUER_SEED;
        if (!seed)
            throw new Error('Set ISSUER_SEED in the environment or .env');
        const issuer = Wallet.fromSeed(seed);
        if (issuer.classicAddress !== ISSUER)
            throw new Error('Seed does not match expected issuer');
        const holder = Wallet.generate();
        await writeFile('.holder.json', JSON.stringify({ address: holder.classicAddress,
            seed: holder.seed }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await writeFile('.run-started', new Date().toISOString(), { flag: 'wx' });
        const created = await submit({
            TransactionType: 'MPTokenIssuanceCreate', Account: issuer.classicAddress,
            AssetScale: 0, Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
        }, issuer);
        const issuanceId = created.mpt_issuance_id;
        if (!issuanceId)
            throw new Error('Validated creation metadata omitted issuance ID');
        console.log(`Issuance ID: ${issuanceId}`);
        await submit({ TransactionType: 'Payment', Account: issuer.classicAddress,
            Destination: holder.classicAddress, Amount: xrpToDrops('10') }, issuer);
        await submit({ TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress,
            MPTokenIssuanceID: issuanceId }, holder);
        await submit({ TransactionType: 'MPTokenAuthorize', Account: issuer.classicAddress,
            MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress }, issuer);
        await submit({ TransactionType: 'Payment', Account: issuer.classicAddress,
            Destination: holder.classicAddress,
            Amount: { mpt_issuance_id: issuanceId, value: '1000' } }, issuer);
        await readBalances(issuanceId, holder.classicAddress);
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Unexpected error');
    process.exitCode = 1;
});
