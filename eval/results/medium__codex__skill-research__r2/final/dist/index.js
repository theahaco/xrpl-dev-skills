import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Client, Wallet, xrpToDrops } from 'xrpl';
import { authorize, createIssuance, tokenPayment } from './transactions.js';
const ENDPOINT = 'wss://s.altnet.rippletest.net:51233';
const ISSUER = 'rhFHiXkJAN7p6Un4dZ47NLU5zFhbVV4akK';
const MPT_AMENDMENT = '950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38';
const AMENDMENTS_ENTRY = '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4';
const client = new Client(ENDPOINT, { maxFeeXRP: '0.01' });
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
function checkSuccess(response) {
    assert.equal(response.result.validated, true, 'Transaction must be validated');
    const meta = response.result.meta;
    assert(meta && typeof meta !== 'string', 'Missing transaction metadata');
    assert.equal(meta.TransactionResult, 'tesSUCCESS', `Transaction failed: ${meta.TransactionResult}`);
}
// Save signed transactions before submission. A restart reuses the hash/sequence,
// never silently creates another issuance or sends another 1000 tokens.
async function submit(label, tx, wallet) {
    const receiptPath = `receipts/${label}.json`;
    if (existsSync(receiptPath)) {
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        checkSuccess(receipt);
        return receipt;
    }
    const pendingPath = `.secrets/${label}.json`;
    let signed;
    if (existsSync(pendingPath)) {
        signed = JSON.parse(readFileSync(pendingPath, 'utf8'));
        try {
            const found = await client.request({ command: 'tx', transaction: signed.hash });
            if (found.result.validated) {
                save(receiptPath, found);
                checkSuccess(found);
                return found;
            }
        }
        catch (error) {
            if (!(error instanceof Error) || !('data' in error) ||
                error.data.error !== 'txnNotFound')
                throw error;
        }
    }
    else {
        const prepared = await client.autofill(tx);
        assert(prepared.LastLedgerSequence, 'A bounded ledger expiry is required');
        assert(prepared.Fee);
        assert(BigInt(prepared.Fee) <= 10000n, 'Fee exceeds 0.01 XRP limit');
        signed = wallet.sign(prepared);
        writeFileSync(pendingPath, JSON.stringify(signed), { mode: 0o600 });
    }
    console.log(`${label}: ${signed.hash}`);
    const response = await client.submitAndWait(signed.tx_blob);
    save(receiptPath, response);
    checkSuccess(response);
    return response;
}
async function readBalances(issuanceId, holder) {
    const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
    assert.equal(ledger.result.validated, true);
    const ledger_hash = ledger.result.ledger_hash;
    const [issuance, holding] = await Promise.all([
        client.request({ command: 'ledger_entry', mpt_issuance: issuanceId, ledger_hash }),
        client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: issuanceId, account: holder }, ledger_hash }),
    ]);
    assert.equal(issuance.result.validated, true);
    assert.equal(holding.result.validated, true);
    const i = issuance.result.node;
    // xrpl 5.3.0 omits MPToken from its public LedgerEntry union.
    const h = holding.result.node;
    assert(i.LedgerEntryType === 'MPTokenIssuance');
    assert(h);
    assert(h.LedgerEntryType === 'MPToken');
    assert.equal(i.Issuer, ISSUER);
    assert.equal(h.MPTokenIssuanceID, issuanceId);
    assert((i.Flags & 4) !== 0, 'Issuer approval must be required');
    assert((h.Flags & 2) !== 0, 'Holder must be approved');
    assert.equal(i.AssetScale ?? 0, 0);
    assert.equal(h.MPTAmount, '1000');
    assert.equal(i.OutstandingAmount, '1000');
    save('ledger-snapshot.json', { endpoint: ENDPOINT, checkedAt: new Date().toISOString(), ledger: ledger.result, issuance: issuance.result, holding: holding.result });
    const result = { issuanceId, holder, holderBalance: h.MPTAmount, outstandingAmount: i.OutstandingAmount };
    save('result.json', result);
    console.log(JSON.stringify(result, null, 2));
    return result;
}
async function main() {
    await client.connect();
    try {
        const info = await client.request({ command: 'server_info' });
        assert.equal(info.result.info.network_id, 1, 'Expected XRPL Testnet');
        if (process.argv.includes('--verify') || existsSync('result.json')) {
            const previous = JSON.parse(readFileSync('result.json', 'utf8'));
            await readBalances(previous.issuanceId, previous.holder);
            return;
        }
        const seed = process.env.ISSUER_SEED;
        assert(seed, 'Set ISSUER_SEED in the environment or .env');
        const issuer = Wallet.fromSeed(seed);
        assert.equal(issuer.classicAddress, ISSUER, 'Seed does not match the supplied issuer');
        const amendments = await client.request({ command: 'ledger_entry', index: AMENDMENTS_ENTRY, ledger_index: 'validated' });
        assert.equal(amendments.result.validated, true);
        assert(amendments.result.node.LedgerEntryType === 'Amendments');
        assert(amendments.result.node.Amendments?.includes(MPT_AMENDMENT), 'MPTokensV1 is not enabled');
        const reserves = info.result.info.validated_ledger;
        assert(reserves);
        const funding = xrpToDrops('2');
        const base = BigInt(xrpToDrops(String(reserves.reserve_base_xrp)));
        const increment = BigInt(xrpToDrops(String(reserves.reserve_inc_xrp)));
        assert(BigInt(funding) > base + increment + 10000n, 'Holder funding is insufficient for current reserves');
        const account = await client.request({ command: 'account_info', account: ISSUER, ledger_index: 'validated' });
        assert(BigInt(account.result.account_data.Balance) > BigInt(funding) + base + increment * BigInt(account.result.account_data.OwnerCount + 1) + 40000n, 'Issuer balance is insufficient');
        mkdirSync('.secrets', { recursive: true, mode: 0o700 });
        mkdirSync('receipts', { recursive: true });
        save('receipts/preflight.json', { checkedAt: new Date().toISOString(), info, amendments });
        const holderPath = '.secrets/holder.json';
        let holder;
        if (existsSync(holderPath)) {
            const saved = JSON.parse(readFileSync(holderPath, 'utf8'));
            holder = Wallet.fromSeed(saved.seed);
        }
        else {
            holder = Wallet.generate();
            writeFileSync(holderPath, JSON.stringify({ address: holder.classicAddress, seed: holder.seed }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        }
        await submit('01-fund-holder', { TransactionType: 'Payment', Account: ISSUER, Destination: holder.classicAddress, Amount: funding }, issuer);
        const creation = await submit('02-create-issuance', createIssuance(ISSUER), issuer);
        const meta = creation.result.meta;
        assert(meta && typeof meta !== 'string' && 'mpt_issuance_id' in meta);
        const issuanceId = meta.mpt_issuance_id;
        assert(typeof issuanceId === 'string' && /^[A-F0-9]{48}$/i.test(issuanceId));
        await submit('03-holder-opt-in', authorize(holder.classicAddress, issuanceId), holder);
        await submit('04-issuer-approval', authorize(ISSUER, issuanceId, holder.classicAddress), issuer);
        await submit('05-send-tokens', tokenPayment(ISSUER, holder.classicAddress, issuanceId), issuer);
        await readBalances(issuanceId, holder.classicAddress);
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Unknown failure');
    process.exitCode = 1;
});
