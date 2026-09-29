import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { Client, Wallet, MPTokenIssuanceCreateFlags, MPTokenIssuanceFlags, xrpToDrops } from 'xrpl';
const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rE93cZ289p6yHdZ68UQZR26jbCPG6rbzQx';
const client = new Client(endpoint);
const json = (value) => JSON.stringify(value, null, 2) + '\n';
async function submit(label, tx, wallet) {
    const prepared = await client.autofill(tx);
    const signed = wallet.sign(prepared);
    // Save the hash before submission so an interrupted run can be investigated.
    await appendFile('transactions.jsonl', json({ label, hash: signed.hash }).replace(/\n\s*/g, '') + '\n');
    const response = await client.submitAndWait(signed.tx_blob);
    const { meta } = response.result;
    assert.equal(response.result.validated, true, `${label}: not validated`);
    assert(meta && typeof meta !== 'string', `${label}: missing metadata`);
    assert.equal(meta.TransactionResult, 'tesSUCCESS', `${label}: transaction failed`);
    await writeFile(`${label}.json`, json(response.result));
    console.log(`${label}: ${signed.hash} (validated tesSUCCESS)`);
    return response.result;
}
async function readBalances(issuanceId, holder) {
    const issuanceResponse = await client.request({
        command: 'ledger_entry', mpt_issuance: issuanceId, ledger_index: 'validated',
    });
    assert.equal(issuanceResponse.result.validated, true);
    const holderResponse = await client.request({
        command: 'ledger_entry', mptoken: { account: holder, mpt_issuance_id: issuanceId },
        ledger_hash: issuanceResponse.result.ledger_hash,
    });
    assert.equal(holderResponse.result.validated, true);
    const issuance = issuanceResponse.result.node;
    const holding = holderResponse.result.node;
    assert.equal(issuance.LedgerEntryType, 'MPTokenIssuance');
    assert.equal(holding.LedgerEntryType, 'MPToken');
    if (issuance.LedgerEntryType !== 'MPTokenIssuance' || holding.LedgerEntryType !== 'MPToken') {
        throw new Error('Unexpected ledger object types');
    }
    assert.equal(issuance.Issuer, issuerAddress);
    assert(issuance.Flags & MPTokenIssuanceFlags.lsfMPTRequireAuth);
    assert(holding.Flags & 0x00000002, 'Holder must have lsfMPTAuthorized');
    assert.equal(holding.MPTokenIssuanceID, issuanceId);
    assert.equal(holding.MPTAmount, '1000');
    assert.equal(issuance.OutstandingAmount, '1000');
    const result = { issuanceId, holder, holderBalance: holding.MPTAmount,
        outstandingAmount: issuance.OutstandingAmount };
    await writeFile('ledger-evidence.json', json({ issuance: issuanceResponse.result, holder: holderResponse.result }));
    await writeFile('result.json', json(result));
    console.log(json(result));
}
async function main() {
    await client.connect();
    try {
        const server = await client.request({ command: 'server_info' });
        assert.equal(server.result.info.network_id, 1, 'Expected XRP Ledger testnet');
        if (process.argv.includes('--verify')) {
            const result = JSON.parse(await readFile('result.json', 'utf8'));
            assert(result && typeof result === 'object' && 'issuanceId' in result && 'holder' in result);
            assert(typeof result.issuanceId === 'string' && typeof result.holder === 'string');
            await readBalances(result.issuanceId, result.holder);
            return;
        }
        const features = await client.request({ command: 'feature' });
        assert(Object.values(features.result.features).some(f => f.name === 'MPTokensV1' && f.enabled), 'MPTokensV1 is not enabled');
        await writeFile('amendments.json', json({ checkedAt: new Date().toISOString(), endpoint,
            server: server.result.info, features: features.result.features }));
        const seed = process.env.ISSUER_SEED;
        assert(seed, 'Set ISSUER_SEED to the funded testnet issuer seed');
        const issuer = Wallet.fromSeed(seed);
        assert.equal(issuer.classicAddress, issuerAddress, 'Issuer seed/address mismatch');
        // Refuse accidental reruns, including after interruption. Use --verify to read again.
        await writeFile('.run-started', new Date().toISOString(), { flag: 'wx', mode: 0o600 });
        const holder = Wallet.generate();
        await writeFile('.holder.json', json({ address: holder.classicAddress, seed: holder.seed }), { flag: 'wx', mode: 0o600 });
        await submit('01-fund-holder', { TransactionType: 'Payment', Account: issuerAddress,
            Destination: holder.classicAddress, Amount: xrpToDrops(5) }, issuer);
        const created = await submit('02-create-issuance', {
            TransactionType: 'MPTokenIssuanceCreate', Account: issuerAddress, AssetScale: 0,
            Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
        }, issuer);
        const meta = created.meta;
        assert(meta && typeof meta !== 'string' && 'mpt_issuance_id' in meta);
        const issuanceId = meta.mpt_issuance_id;
        assert(typeof issuanceId === 'string' && /^[A-F0-9]{48}$/.test(issuanceId));
        await submit('03-holder-opt-in', { TransactionType: 'MPTokenAuthorize',
            Account: holder.classicAddress, MPTokenIssuanceID: issuanceId }, holder);
        await submit('04-issuer-approval', { TransactionType: 'MPTokenAuthorize',
            Account: issuerAddress, MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress }, issuer);
        await submit('05-send-mpt', { TransactionType: 'Payment', Account: issuerAddress,
            Destination: holder.classicAddress, Amount: { mpt_issuance_id: issuanceId, value: '1000' } }, issuer);
        await readBalances(issuanceId, holder.classicAddress);
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
});
