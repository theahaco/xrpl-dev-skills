import { readFile, writeFile, rename } from 'node:fs/promises';
import { Client, Wallet, MPTokenIssuanceCreateFlags, xrpToDrops, } from 'xrpl';
const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rfWb2bXAar5BKcGcTwfqpTQaF4rXnuQ59N';
const statePath = '.mpt-state.json';
async function save(path, value, privateFile = false) {
    await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', {
        mode: privateFile ? 0o600 : 0o644,
    });
    await rename(`${path}.tmp`, path);
}
async function main() {
    const seed = process.env.ISSUER_SEED;
    if (!seed)
        throw new Error('Set ISSUER_SEED to the testnet issuer seed.');
    const issuer = Wallet.fromSeed(seed);
    if (issuer.classicAddress !== issuerAddress)
        throw new Error('Issuer seed/address mismatch.');
    let state;
    try {
        state = JSON.parse(await readFile(statePath, 'utf8'));
    }
    catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw error;
        state = { holderSeed: Wallet.generate().seed, steps: {} };
        await save(statePath, state, true);
    }
    const holder = Wallet.fromSeed(state.holderSeed);
    const client = new Client(endpoint, { connectionTimeout: 20_000, timeout: 30_000 });
    // Persist signed blobs before submitting. A restart reuses the same transaction,
    // preventing duplicate issuance/payment if a response was lost.
    async function submit(name, tx, wallet) {
        let step = state.steps[name];
        if (step?.meta)
            return step.meta;
        if (!step) {
            const prepared = await client.autofill(tx);
            if (!prepared.LastLedgerSequence)
                throw new Error('Missing transaction expiry.');
            const signed = wallet.sign(prepared);
            step = { blob: signed.tx_blob, hash: signed.hash };
            state.steps[name] = step;
            await save(statePath, state, true);
        }
        // First look up a previously submitted transaction before resubmitting its blob.
        let result;
        try {
            result = (await client.request({ command: 'tx', transaction: step.hash })).result;
        }
        catch (error) {
            if (!(error instanceof Error && 'data' in error &&
                error.data.error === 'txnNotFound'))
                throw error;
        }
        if (!result?.validated)
            result = (await client.submitAndWait(step.blob)).result;
        const meta = result.meta;
        if (!result.validated || !meta || typeof meta === 'string') {
            throw new Error(`${name}: missing validated metadata (${step.hash}).`);
        }
        if (meta.TransactionResult !== 'tesSUCCESS') {
            throw new Error(`${name}: ${meta.TransactionResult} (${step.hash}); stopping.`);
        }
        step.meta = meta;
        await save(statePath, state, true);
        console.log(`${name}: validated tesSUCCESS ${step.hash}`);
        return meta;
    }
    try {
        await client.connect();
        const info = (await client.request({ command: 'server_info' })).result.info;
        if (info.network_id !== 1)
            throw new Error('Expected XRPL testnet network ID 1.');
        const ledger = info.validated_ledger;
        if (!ledger)
            throw new Error('Server has no validated ledger.');
        console.log(`Testnet reserves: base ${ledger.reserve_base_xrp} XRP; owner ${ledger.reserve_inc_xrp} XRP.`);
        if (ledger.reserve_base_xrp + ledger.reserve_inc_xrp >= 5) {
            throw new Error('5 XRP holder funding is insufficient for current reserves and fees.');
        }
        const account = (await client.request({
            command: 'account_info', account: issuerAddress, ledger_index: 'validated',
        })).result.account_data;
        const required = ledger.reserve_base_xrp + (account.OwnerCount + 1) * ledger.reserve_inc_xrp + 5 + 0.1;
        if (!state.steps.fund && BigInt(account.Balance) < BigInt(xrpToDrops(required))) {
            throw new Error('Insufficient issuer XRP for funding, reserves, and fees.');
        }
        await submit('fund', {
            TransactionType: 'Payment', Account: issuerAddress,
            Destination: holder.classicAddress, Amount: xrpToDrops(5),
        }, issuer);
        const created = await submit('create', {
            TransactionType: 'MPTokenIssuanceCreate', Account: issuerAddress,
            AssetScale: 0, MaximumAmount: '1000000',
            Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
                MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
        }, issuer);
        if (!('mpt_issuance_id' in created) || typeof created.mpt_issuance_id !== 'string') {
            throw new Error('Issuance ID missing from validated creation metadata.');
        }
        const issuanceId = created.mpt_issuance_id;
        await submit('optIn', {
            TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress,
            MPTokenIssuanceID: issuanceId,
        }, holder);
        await submit('approve', {
            TransactionType: 'MPTokenAuthorize', Account: issuerAddress,
            MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress,
        }, issuer);
        await submit('send', {
            TransactionType: 'Payment', Account: issuerAddress,
            Destination: holder.classicAddress,
            Amount: { mpt_issuance_id: issuanceId, value: '1000' },
        }, issuer);
        // Read both amounts at exactly the same validated ledger snapshot.
        const snapshot = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result;
        const [holding, issuance] = await Promise.all([
            client.request({ command: 'ledger_entry', ledger_hash: snapshot.ledger_hash,
                mptoken: { account: holder.classicAddress, mpt_issuance_id: issuanceId } }),
            client.request({ command: 'ledger_entry', ledger_hash: snapshot.ledger_hash,
                mpt_issuance: issuanceId }),
        ]);
        // xrpl 5.3's LedgerEntry union omits MPToken; validate the discriminant below.
        const h = holding.result.node;
        const i = issuance.result.node;
        if (!holding.result.validated || !issuance.result.validated ||
            h.LedgerEntryType !== 'MPToken' || i.LedgerEntryType !== 'MPTokenIssuance') {
            throw new Error('Unexpected ledger entries or unvalidated reads.');
        }
        if (!(i.Flags & MPTokenIssuanceCreateFlags.tfMPTRequireAuth) ||
            !(h.Flags & 0x00000002))
            throw new Error('Missing require-auth or holder authorization flag.');
        const result = {
            issuanceId, holder: holder.classicAddress,
            holderBalance: h.MPTAmount, outstandingAmount: i.OutstandingAmount,
        };
        if (result.holderBalance !== '1000' || result.outstandingAmount !== '1000') {
            throw new Error(`Unexpected ledger amounts: ${JSON.stringify(result)}`);
        }
        await save('result.json', result);
        await save('verification.json', {
            endpoint, ledgerHash: snapshot.ledger_hash, ledgerIndex: snapshot.ledger_index,
            transactions: Object.fromEntries(Object.entries(state.steps).map(([name, step]) => [name, step.hash])),
            holding: h, issuance: i,
        });
        console.log(JSON.stringify(result, null, 2));
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Unexpected failure.');
    process.exitCode = 1;
});
