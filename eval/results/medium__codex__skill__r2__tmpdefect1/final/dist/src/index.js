"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const strict_1 = __importDefault(require("node:assert/strict"));
const xrpl_1 = require("xrpl");
const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rQrYRxcY7K6oVjdkjZL5XgRN9UKCY648av';
const client = new xrpl_1.Client(endpoint);
const evidence = [];
async function submit(label, tx, wallet) {
    // autofill supplies the current sequence, fee and LastLedgerSequence.
    const prepared = await client.autofill(tx);
    (0, strict_1.default)(prepared.LastLedgerSequence !== undefined);
    const signed = wallet.sign(prepared);
    console.log(`${label}: ${signed.hash}`);
    // Persist the hash before submission so an interrupted run can be investigated.
    await (0, promises_1.writeFile)('pending-transaction.json', JSON.stringify({ label, hash: signed.hash,
        lastLedgerSequence: prepared.LastLedgerSequence }, null, 2) + '\n');
    const { result } = await client.submitAndWait(signed.tx_blob);
    strict_1.default.equal(result.validated, true, `${label} was not validated`);
    const meta = result.meta;
    (0, strict_1.default)(meta && typeof meta === 'object', 'Missing transaction metadata');
    strict_1.default.equal(meta.TransactionResult, 'tesSUCCESS', `${label}: ${meta.TransactionResult}`);
    evidence.push({ label, hash: signed.hash, ledgerIndex: result.ledger_index });
    await (0, promises_1.writeFile)('transactions.json', JSON.stringify(evidence, null, 2) + '\n');
    return meta;
}
async function readBalances(issuanceId, holder) {
    // Pin both reads to the same validated ledger snapshot.
    const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
    strict_1.default.equal(ledger.result.validated, true);
    const ledgerHash = ledger.result.ledger_hash;
    const [issuanceResponse, holderResponse] = await Promise.all([
        client.request({ command: 'ledger_entry', mpt_issuance: issuanceId,
            ledger_hash: ledgerHash }),
        client.request({ command: 'ledger_entry', mptoken: {
                mpt_issuance_id: issuanceId, account: holder
            }, ledger_hash: ledgerHash }),
    ]);
    strict_1.default.equal(issuanceResponse.result.validated, true);
    strict_1.default.equal(holderResponse.result.validated, true);
    const issuance = issuanceResponse.result.node;
    const holding = holderResponse.result.node;
    (0, strict_1.default)(issuance?.LedgerEntryType === 'MPTokenIssuance');
    (0, strict_1.default)(holding?.LedgerEntryType === 'MPToken');
    strict_1.default.equal(issuance.Issuer, issuerAddress);
    (0, strict_1.default)(issuance.Flags & xrpl_1.MPTokenIssuanceCreateFlags.tfMPTRequireAuth);
    (0, strict_1.default)(holding.Flags & 2, 'Holder must have lsfMPTAuthorized');
    const result = { issuanceId, holder, holderBalance: holding.MPTAmount,
        outstandingAmount: issuance.OutstandingAmount };
    await (0, promises_1.writeFile)('ledger-evidence.json', JSON.stringify({ ledgerHash,
        ledgerIndex: ledger.result.ledger_index, issuance, holding }, null, 2) + '\n');
    await (0, promises_1.writeFile)('result.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
    return result;
}
async function main() {
    await client.connect();
    try {
        const info = (await client.request({ command: 'server_info' })).result.info;
        strict_1.default.equal(info.network_id, 1, 'Expected XRPL testnet');
        if (process.argv.includes('--read')) {
            const saved = JSON.parse(await (0, promises_1.readFile)('issuance.json', 'utf8'));
            (0, strict_1.default)(saved && typeof saved === 'object' && 'issuanceId' in saved &&
                'holder' in saved && typeof saved.issuanceId === 'string' &&
                typeof saved.holder === 'string');
            await readBalances(saved.issuanceId, saved.holder);
            return;
        }
        (0, strict_1.default)(!(0, node_fs_1.existsSync)('.holder.json'), 'A run already exists. Use npm run read; inspect transaction hashes before restarting.');
        const seed = process.env.ISSUER_SEED;
        (0, strict_1.default)(seed, 'Set ISSUER_SEED to your testnet seed');
        const issuer = xrpl_1.Wallet.fromSeed(seed);
        strict_1.default.equal(issuer.classicAddress, issuerAddress, 'Unexpected issuer');
        const reserves = info.validated_ledger;
        (0, strict_1.default)(reserves);
        console.log(`Reserves: ${reserves.reserve_base_xrp} XRP base, ` +
            `${reserves.reserve_inc_xrp} XRP per object. Each account will own one MPT object.`);
        (0, strict_1.default)(5 > reserves.reserve_base_xrp + reserves.reserve_inc_xrp + 0.01);
        const account = (await client.request({ command: 'account_info',
            account: issuerAddress, ledger_index: 'validated' })).result.account_data;
        const needed = 5.01 + reserves.reserve_base_xrp +
            (account.OwnerCount + 1) * reserves.reserve_inc_xrp;
        (0, strict_1.default)(BigInt(account.Balance) > BigInt((0, xrpl_1.xrpToDrops)(needed)), 'Insufficient issuer XRP');
        const holder = xrpl_1.Wallet.generate();
        await (0, promises_1.writeFile)('.holder.json', JSON.stringify({ address: holder.classicAddress,
            seed: holder.seed }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await submit('Fund holder with 5 test XRP', { TransactionType: 'Payment',
            Account: issuerAddress, Destination: holder.classicAddress, Amount: (0, xrpl_1.xrpToDrops)(5) }, issuer);
        const meta = await submit('Create authorized MPT', {
            TransactionType: 'MPTokenIssuanceCreate', Account: issuerAddress,
            AssetScale: 0, MaximumAmount: '1000000',
            Flags: xrpl_1.MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
                xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
        }, issuer);
        (0, strict_1.default)('mpt_issuance_id' in meta && typeof meta.mpt_issuance_id === 'string', 'Issuance ID missing from validated creation metadata');
        const issuanceId = meta.mpt_issuance_id;
        await (0, promises_1.writeFile)('issuance.json', JSON.stringify({ issuanceId,
            holder: holder.classicAddress }, null, 2) + '\n');
        await submit('Holder opts in', { TransactionType: 'MPTokenAuthorize',
            Account: holder.classicAddress, MPTokenIssuanceID: issuanceId }, holder);
        await submit('Issuer approves holder', { TransactionType: 'MPTokenAuthorize',
            Account: issuerAddress, MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress }, issuer);
        await submit('Send 1000 MPT', { TransactionType: 'Payment', Account: issuerAddress,
            Destination: holder.classicAddress, Amount: { mpt_issuance_id: issuanceId, value: '1000' } }, issuer);
        const result = await readBalances(issuanceId, holder.classicAddress);
        strict_1.default.equal(result.holderBalance, '1000');
        strict_1.default.equal(result.outstandingAmount, '1000');
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
});
