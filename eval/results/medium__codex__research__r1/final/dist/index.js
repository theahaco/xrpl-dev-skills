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
const issuerAddress = 'rpiVYqiq6JUj2MwMLtnut5qjX5FQ2Ck1gV';
const mptAmendment = '950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38';
const client = new xrpl_1.Client(endpoint);
const json = (value) => JSON.stringify(value, null, 2) + '\n';
async function submit(transaction, wallet) {
    const prepared = await client.autofill(transaction);
    const signed = wallet.sign(prepared);
    // Save the hash before submitting so an interrupted run can be investigated.
    await (0, promises_1.appendFile)('transactions.jsonl', JSON.stringify({
        phase: 'prepared', type: transaction.TransactionType, hash: signed.hash,
        lastLedgerSequence: prepared.LastLedgerSequence,
    }) + '\n');
    const response = await client.submitAndWait(signed.tx_blob);
    const { meta } = response.result;
    (0, strict_1.default)(response.result.validated, 'Transaction must be validated');
    (0, strict_1.default)(meta && typeof meta !== 'string', 'Expected decoded metadata');
    await (0, promises_1.appendFile)('transactions.jsonl', JSON.stringify({
        phase: 'validated', type: transaction.TransactionType, hash: signed.hash,
        ledgerIndex: response.result.ledger_index, result: meta.TransactionResult,
    }) + '\n');
    strict_1.default.equal(meta.TransactionResult, 'tesSUCCESS');
    console.log(`${transaction.TransactionType}: ${signed.hash}`);
    return response.result;
}
async function readBalances(issuanceId, holder) {
    const ledgerIndex = await client.getLedgerIndex();
    const issuanceResponse = await client.request({
        command: 'ledger_entry', mpt_issuance: issuanceId, ledger_index: ledgerIndex,
    });
    const holderResponse = await client.request({
        command: 'ledger_entry', mptoken: { account: holder, mpt_issuance_id: issuanceId },
        ledger_index: ledgerIndex,
    });
    (0, strict_1.default)(issuanceResponse.result.validated && holderResponse.result.validated);
    const issuance = issuanceResponse.result.node;
    // xrpl 5.3.0 omits MPToken from its LedgerEntry union. Validate these fields.
    const token = holderResponse.result.node;
    (0, strict_1.default)(issuance.LedgerEntryType === 'MPTokenIssuance');
    (0, strict_1.default)(token.LedgerEntryType === 'MPToken');
    strict_1.default.equal(issuance.Issuer, issuerAddress);
    (0, strict_1.default)(issuance.Flags & 0x00000004, 'Issuance must require authorization');
    (0, strict_1.default)(typeof token.Flags === 'number' && typeof token.MPTAmount === 'string');
    (0, strict_1.default)(token.Flags & 0x00000002, 'Holder must have lsfMPTAuthorized');
    strict_1.default.equal(token.MPTAmount, '1000');
    strict_1.default.equal(issuance.OutstandingAmount, '1000');
    await (0, promises_1.writeFile)('verification.json', json({
        endpoint, issuance: issuanceResponse.result, holder: holderResponse.result,
    }));
    const result = { issuanceId, holder, holderBalance: token.MPTAmount,
        outstandingAmount: issuance.OutstandingAmount };
    await (0, promises_1.writeFile)('result.json', json(result));
    console.log(json(result));
}
async function main() {
    await client.connect();
    try {
        if (process.argv.includes('--verify')) {
            const saved = JSON.parse(await (0, promises_1.readFile)('result.json', 'utf8'));
            await readBalances(saved.issuanceId, saved.holder);
            return;
        }
        (0, strict_1.default)(!(0, node_fs_1.existsSync)('transactions.jsonl') && !(0, node_fs_1.existsSync)('holder-wallet.json'), 'A run already exists. Use npm run verify; inspect the journal before starting another issuance.');
        const seed = process.env.ISSUER_SEED;
        (0, strict_1.default)(seed, 'Set ISSUER_SEED in .env or the environment');
        const issuer = xrpl_1.Wallet.fromSeed(seed);
        strict_1.default.equal(issuer.classicAddress, issuerAddress, 'Incorrect issuer seed');
        const amendments = await client.request({
            command: 'ledger_entry', amendments: true, ledger_index: 'validated',
        });
        (0, strict_1.default)(amendments.result.validated);
        (0, strict_1.default)(amendments.result.node.LedgerEntryType === 'Amendments');
        (0, strict_1.default)(amendments.result.node.Amendments?.includes(mptAmendment), 'MPTokensV1 is not enabled');
        await (0, promises_1.writeFile)('research/run-amendments.json', json(amendments.result));
        const holder = xrpl_1.Wallet.generate();
        await (0, promises_1.writeFile)('holder-wallet.json', json({ address: holder.classicAddress,
            seed: holder.seed }), { mode: 0o600, flag: 'wx' });
        await submit({ TransactionType: 'Payment', Account: issuerAddress,
            Destination: holder.classicAddress, Amount: (0, xrpl_1.xrpToDrops)('10') }, issuer);
        const creation = await submit({ TransactionType: 'MPTokenIssuanceCreate',
            Account: issuerAddress, AssetScale: 0, MaximumAmount: '1000',
            Flags: xrpl_1.MPTokenIssuanceCreateFlags.tfMPTRequireAuth }, issuer);
        const meta = creation.meta;
        (0, strict_1.default)(meta && typeof meta !== 'string');
        (0, strict_1.default)('mpt_issuance_id' in meta);
        const issuanceId = meta.mpt_issuance_id;
        (0, strict_1.default)(typeof issuanceId === 'string' && /^[A-F0-9]{48}$/i.test(issuanceId));
        await (0, promises_1.writeFile)('issuance.json', json({ issuanceId, holder: holder.classicAddress }));
        await submit({ TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress,
            MPTokenIssuanceID: issuanceId }, holder);
        await submit({ TransactionType: 'MPTokenAuthorize', Account: issuerAddress,
            MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress }, issuer);
        await submit({ TransactionType: 'Payment', Account: issuerAddress,
            Destination: holder.classicAddress,
            Amount: { mpt_issuance_id: issuanceId, value: '1000' } }, issuer);
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
