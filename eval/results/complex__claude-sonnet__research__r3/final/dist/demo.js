"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
require("dotenv/config");
const xrpl_1 = require("xrpl");
const mptIssuer_1 = require("./mptIssuer");
const TESTNET_WS_URL = process.env.TESTNET_WS_URL ?? 'wss://s.altnet.rippletest.net:51233';
const ISSUER_SEED = process.env.ISSUER_SEED;
function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}
function log(step, detail) {
    console.log(detail ? `${step} ${detail}` : step);
}
async function main() {
    if (ISSUER_SEED == null || ISSUER_SEED.length === 0) {
        throw new Error('ISSUER_SEED must be set (see .env.example)');
    }
    const client = new xrpl_1.Client(TESTNET_WS_URL);
    await client.connect();
    log(`Connected to ${TESTNET_WS_URL}`);
    try {
        const issuerWallet = xrpl_1.Wallet.fromSeed(ISSUER_SEED);
        log('Issuer account:', issuerWallet.address);
        log('Funding holder accounts A, B, C from the testnet faucet...');
        const [fundedA, fundedB, fundedC] = await Promise.all([
            client.fundWallet(),
            client.fundWallet(),
            client.fundWallet(),
        ]);
        const walletA = fundedA.wallet;
        const walletB = fundedB.wallet;
        const walletC = fundedC.wallet;
        log('Holder A:', walletA.address);
        log('Holder B:', walletB.address);
        log('Holder C:', walletC.address);
        const issuer = new mptIssuer_1.MptIssuer(client, issuerWallet);
        // ---------------------------------------------------------------
        // 1. Create the issuance with every compliance control enabled.
        // ---------------------------------------------------------------
        log('\n=== Creating MPT issuance ===');
        const metadata = (0, xrpl_1.encodeMPTokenMetadata)({
            ticker: 'RSTB',
            name: 'Regulated Stablecoin Demo',
            desc: 'Demo issuance exercising allow-list, freeze, clawback and ban controls.',
            icon: 'example.com/rstb-icon.png',
            asset_class: 'rwa',
            asset_subclass: 'stablecoin',
            issuer_name: 'Demo Issuer Co.',
        });
        const { issuanceId } = await issuer.createIssuance({ metadata });
        log('Issuance created:', issuanceId);
        // ---------------------------------------------------------------
        // 2. Allow-list: A, B, and C opt in and are KYC-approved.
        // ---------------------------------------------------------------
        log('\n=== Allow-listing holders A, B, C ===');
        for (const [label, wallet] of [
            ['A', walletA],
            ['B', walletB],
            ['C', walletC],
        ]) {
            await issuer.requestHolderOptIn(wallet, issuanceId);
            await issuer.approveHolder(issuanceId, wallet.address);
            const authorized = await issuer.isHolderAuthorized(issuanceId, wallet.address);
            assert(authorized, `holder ${label} should be authorized after approval`);
            log(`Holder ${label} opted in and approved.`);
        }
        // ---------------------------------------------------------------
        // 3. Issue tokens to A, then freeze and unfreeze A.
        // ---------------------------------------------------------------
        log('\n=== Holder A: issue, freeze, unfreeze ===');
        await issuer.issueTo(issuanceId, walletA.address, '500');
        assert((await issuer.getBalance(issuanceId, walletA.address)) === '500', 'A should hold 500 after issuance');
        log('Issued 500 to A.');
        await issuer.freezeHolder(issuanceId, walletA.address);
        assert(await issuer.isHolderFrozen(issuanceId, walletA.address), 'A should be frozen');
        log('A frozen.');
        await issuer.unfreezeHolder(issuanceId, walletA.address);
        assert(!(await issuer.isHolderFrozen(issuanceId, walletA.address)), 'A should be unfrozen');
        log('A unfrozen.');
        // ---------------------------------------------------------------
        // 4. Issue tokens to B, claw back part of the balance, freeze B.
        // ---------------------------------------------------------------
        log('\n=== Holder B: issue, partial clawback, freeze ===');
        await issuer.issueTo(issuanceId, walletB.address, '1000');
        assert((await issuer.getBalance(issuanceId, walletB.address)) === '1000', 'B should hold 1000 after issuance');
        log('Issued 1000 to B.');
        await issuer.clawback(issuanceId, walletB.address, '300');
        const balanceB = await issuer.getBalance(issuanceId, walletB.address);
        assert(balanceB === '700', `B should hold 700 after clawback, got ${balanceB}`);
        log('Clawed back 300 from B; B now holds 700.');
        await issuer.freezeHolder(issuanceId, walletB.address);
        assert(await issuer.isHolderFrozen(issuanceId, walletB.address), 'B should be frozen');
        log('B frozen (left frozen).');
        // ---------------------------------------------------------------
        // 5. Issue tokens to C, then ban C entirely.
        // ---------------------------------------------------------------
        log('\n=== Holder C: issue, then ban ===');
        await issuer.issueTo(issuanceId, walletC.address, '250');
        assert((await issuer.getBalance(issuanceId, walletC.address)) === '250', 'C should hold 250 after issuance');
        log('Issued 250 to C.');
        await issuer.banHolder(issuanceId, walletC.address);
        const balanceC = await issuer.getBalance(issuanceId, walletC.address);
        assert(balanceC === '0', `C should hold 0 after ban, got ${balanceC}`);
        assert(!(await issuer.isHolderAuthorized(issuanceId, walletC.address)), 'C should be unauthorized after ban');
        log('C banned: clawed back to 0 and unauthorized.');
        log('Verifying banned holder C cannot be paid again...');
        try {
            await issuer.issueTo(issuanceId, walletC.address, '1');
            throw new Error('Payment to banned holder C unexpectedly succeeded');
        }
        catch (error) {
            log('Payment to banned holder C correctly rejected:', String(error));
        }
        // ---------------------------------------------------------------
        // 6. Global freeze, then lift it.
        // ---------------------------------------------------------------
        log('\n=== Global freeze / unfreeze (incident drill) ===');
        await issuer.globalFreeze(issuanceId);
        assert(await issuer.isGloballyFrozen(issuanceId), 'issuance should be globally frozen');
        log('Issuance globally frozen.');
        log('Verifying transfers are blocked while globally frozen...');
        try {
            await issuer.pay(walletA, issuanceId, walletB.address, '1');
            throw new Error('Payment during global freeze unexpectedly succeeded');
        }
        catch (error) {
            log('Payment during global freeze correctly rejected:', String(error));
        }
        await issuer.globalUnfreeze(issuanceId);
        assert(!(await issuer.isGloballyFrozen(issuanceId)), 'issuance should be unfrozen');
        log('Issuance globally unfrozen.');
        // ---------------------------------------------------------------
        // 7. Final state verification.
        // ---------------------------------------------------------------
        log('\n=== Final state ===');
        const finalBalanceA = await issuer.getBalance(issuanceId, walletA.address);
        const finalFrozenA = await issuer.isHolderFrozen(issuanceId, walletA.address);
        const finalBalanceB = await issuer.getBalance(issuanceId, walletB.address);
        const finalFrozenB = await issuer.isHolderFrozen(issuanceId, walletB.address);
        const finalBalanceC = await issuer.getBalance(issuanceId, walletC.address);
        const finalAuthorizedC = await issuer.isHolderAuthorized(issuanceId, walletC.address);
        const finalGlobalFrozen = await issuer.isGloballyFrozen(issuanceId);
        log(`A: balance=${finalBalanceA} frozen=${finalFrozenA}`);
        log(`B: balance=${finalBalanceB} frozen=${finalFrozenB}`);
        log(`C: balance=${finalBalanceC} authorized=${finalAuthorizedC}`);
        log(`Issuance globally frozen: ${finalGlobalFrozen}`);
        assert(finalBalanceA === '500', 'final: A should hold 500');
        assert(!finalFrozenA, 'final: A should not be frozen');
        assert(finalBalanceB === '700', 'final: B should hold 700');
        assert(finalFrozenB, 'final: B should be frozen');
        assert(finalBalanceC === '0', 'final: C should hold 0');
        assert(!finalAuthorizedC, 'final: C should not be authorized');
        assert(!finalGlobalFrozen, 'final: issuance should not be globally frozen');
        const result = {
            issuanceId,
            holders: {
                A: walletA.address,
                B: walletB.address,
                C: walletC.address,
            },
        };
        const resultPath = node_path_1.default.join(__dirname, '..', 'result.json');
        await (0, promises_1.writeFile)(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        log(`\nWrote ${resultPath}`);
        log('Demo completed successfully.');
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error('Demo failed:', error);
    process.exitCode = 1;
});
//# sourceMappingURL=demo.js.map