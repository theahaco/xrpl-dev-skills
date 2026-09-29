import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Client, Wallet, xrpToDrops } from 'xrpl';
import { createIssuance, tokenPayment } from './transactions.js';
const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rUGmaS3g2eL8DyHqmxTdsRXCy3FYiURkJ7';
const client = new Client(endpoint, { maxFeeXRP: '0.01' });
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const transactions = [];
async function submit(label, tx, wallet) {
    const prepared = await client.autofill(tx);
    assert(prepared.LastLedgerSequence, 'Missing expiry ledger');
    assert(BigInt(prepared.Fee ?? '0') <= 10000n, 'Fee exceeds 0.01 XRP');
    const signed = wallet.sign(prepared);
    // Persist the hash before submission, so ambiguous network failures can be inspected.
    transactions.push({ label, hash: signed.hash });
    await writeFile('transactions.json', json(transactions));
    const response = await client.submitAndWait(signed.tx_blob);
    const { meta, validated, ledger_index } = response.result;
    assert.equal(validated, true, `${label} must be validated`);
    assert(meta && typeof meta !== 'string', 'Missing transaction metadata');
    assert.equal(meta.TransactionResult, 'tesSUCCESS', `${label}: ${meta.TransactionResult}`);
    transactions[transactions.length - 1].ledgerIndex = ledger_index;
    await writeFile('transactions.json', json(transactions));
    console.log(`${label}: ${signed.hash} (validated)`);
    return meta;
}
async function verify(issuanceId, holder) {
    const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
    const ledger_hash = ledger.result.ledger_hash;
    const [issuance, holding] = await Promise.all([
        client.request({ command: 'ledger_entry', mpt_issuance: issuanceId, ledger_hash }),
        client.request({ command: 'ledger_entry', mptoken: { account: holder, mpt_issuance_id: issuanceId }, ledger_hash }),
    ]);
    assert.equal(issuance.result.validated, true);
    assert.equal(holding.result.validated, true);
    const i = issuance.result.node;
    const h = holding.result.node;
    assert(i?.LedgerEntryType === 'MPTokenIssuance');
    assert(h?.LedgerEntryType === 'MPToken');
    assert.equal(i.Issuer, issuerAddress);
    assert.equal(i.Flags & 4, 4, 'Issuer approval must be required');
    assert.equal(h.Flags & 2, 2, 'Holder must be approved');
    assert.equal(h.MPTokenIssuanceID, issuanceId);
    assert.equal(h.MPTAmount, '1000');
    assert.equal(i.OutstandingAmount, '1000');
    const result = { issuanceId, holder, holderBalance: h.MPTAmount, outstandingAmount: i.OutstandingAmount };
    await writeFile('ledger-evidence.json', json({ endpoint, ledgerHash: ledger_hash,
        ledgerIndex: ledger.result.ledger_index, issuance: issuance.result, holding: holding.result }));
    await writeFile('result.json', json(result));
    console.log(json(result));
}
async function main() {
    await client.connect();
    try {
        const info = await client.request({ command: 'server_info' });
        assert.equal(info.result.info.network_id, 1, 'Must be XRPL testnet');
        if (process.argv.includes('--verify')) {
            const result = JSON.parse(await readFile('result.json', 'utf8'));
            await verify(result.issuanceId, result.holder);
            return;
        }
        const features = await client.request({ command: 'feature' });
        assert(Object.values(features.result.features).some(f => f.name === 'MPTokensV1' && f.enabled), 'MPTokensV1 is disabled');
        await writeFile('research/testnet-features.json', json(features));
        await writeFile('research/server-info.json', json(info));
        const seed = process.env.ISSUER_SEED;
        assert(seed, 'Set ISSUER_SEED to the supplied testnet seed');
        const issuer = Wallet.fromSeed(seed);
        assert.equal(issuer.classicAddress, issuerAddress, 'Wrong issuer seed');
        const account = await client.request({ command: 'account_info', account: issuerAddress, ledger_index: 'validated' });
        const reserve = info.result.info.validated_ledger;
        assert(reserve);
        const required = BigInt(xrpToDrops(String(reserve.reserve_base_xrp +
            reserve.reserve_inc_xrp * (account.result.account_data.OwnerCount + 1) + 5 + 0.05)));
        assert(BigInt(account.result.account_data.Balance) >= required, 'Insufficient issuer XRP for funding, reserves and fees');
        // A second run must not silently create another issuance or send another 1000 tokens.
        await writeFile('run-state.json', json({ started: new Date().toISOString() }), { flag: 'wx' });
        const holder = Wallet.generate();
        await writeFile('.holder.json', json({ address: holder.classicAddress, seed: holder.seed }), { flag: 'wx', mode: 0o600 });
        console.log(`Reserves: ${reserve.reserve_base_xrp} XRP base + ${reserve.reserve_inc_xrp} XRP per object. Funding holder with 5 XRP.`);
        const meta = await submit('Create authorized MPT', createIssuance(issuerAddress), issuer);
        assert('mpt_issuance_id' in meta && typeof meta.mpt_issuance_id === 'string', 'Missing issuance ID');
        const issuanceId = meta.mpt_issuance_id;
        await writeFile('run-state.json', json({ issuanceId, holder: holder.classicAddress }));
        await submit('Fund holder', { TransactionType: 'Payment', Account: issuerAddress,
            Destination: holder.classicAddress, Amount: xrpToDrops('5') }, issuer);
        await submit('Holder opt-in', { TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress,
            MPTokenIssuanceID: issuanceId }, holder);
        await submit('Issuer approval', { TransactionType: 'MPTokenAuthorize', Account: issuerAddress,
            MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress }, issuer);
        await submit('Issue 1000 tokens', tokenPayment(issuerAddress, holder.classicAddress, issuanceId), issuer);
        await verify(issuanceId, holder.classicAddress);
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Operation failed');
    process.exitCode = 1;
});
