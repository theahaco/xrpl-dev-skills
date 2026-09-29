"use strict";
/**
 * End-to-end demo of the MPT issuer module against XRP Ledger testnet.
 *
 * Issues a regulated, stablecoin-style MPT from the configured issuer
 * account, onboards three holders (A, B, C), and exercises every
 * compliance control: allowlist, per-holder freeze, global freeze,
 * clawback, and bans. Writes the resulting issuance ID and holder
 * addresses to result.json.
 *
 * Note on freeze semantics (confirmed against a live testnet run): a lock
 * (per-holder or global) blocks holder-to-holder transfers, but per the MPT
 * protocol design it does NOT block issuer-to-holder or holder-to-issuer
 * payments — those remain available so the issuer can keep managing the
 * token (distribute, clawback) during an incident or investigation. The
 * verification steps below test the transfer that a lock actually blocks:
 * a payment between two holders.
 *
 * Usage: npm run demo
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const xrpl_1 = require("xrpl");
const mptIssuer_1 = require("./mptIssuer");
const TESTNET_WS = 'wss://s.altnet.rippletest.net:51233';
const ISSUER_SEED = '<TESTNET_SEED_REDACTED>';
const ISSUER_ADDRESS = 'rJMX5uvngYgN6Y2kLcqkZPie7EE3J5VCDo';
function log(message) {
    // eslint-disable-next-line no-console -- demo script output
    console.log(message);
}
/**
 * Runs `fn` and asserts it throws (i.e. the ledger rejected the operation).
 * Used to prove the compliance controls actually block what they claim to.
 */
async function expectRejected(description, fn) {
    try {
        await fn();
    }
    catch (error) {
        log(`  [OK] rejected as expected: ${description} (${error.message})`);
        return;
    }
    throw new Error(`Expected rejection but transaction succeeded: ${description}`);
}
function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`Assertion failed for ${label}: expected ${expected}, got ${actual}`);
    }
    log(`  [OK] ${label} = ${actual}`);
}
function assertBool(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`Assertion failed for ${label}: expected ${expected}, got ${actual}`);
    }
    log(`  [OK] ${label} = ${actual}`);
}
/** Raw holder-to-holder payment, used only to probe lock enforcement (bypasses the module, which is issuer-only). */
async function peerPayment(client, from, to, issuanceId, value) {
    const response = await client.submitAndWait({
        TransactionType: 'Payment',
        Account: from.address,
        Destination: to,
        Amount: { mpt_issuance_id: issuanceId, value },
    }, { wallet: from });
    const meta = response.result.meta;
    const code = meta && typeof meta !== 'string' ? meta.TransactionResult : undefined;
    if (code !== 'tesSUCCESS') {
        throw new Error(`peer payment rejected with ${code ?? 'unknown'}`);
    }
}
async function main() {
    const client = new xrpl_1.Client(TESTNET_WS);
    await client.connect();
    log(`Connected to ${TESTNET_WS}`);
    try {
        const issuerWallet = xrpl_1.Wallet.fromSeed(ISSUER_SEED);
        if (issuerWallet.address !== ISSUER_ADDRESS) {
            throw new Error(`Issuer seed does not match expected address: got ${issuerWallet.address}, expected ${ISSUER_ADDRESS}`);
        }
        log(`Issuer: ${issuerWallet.address}`);
        log('\n=== Funding holder accounts A, B, C from the testnet faucet ===');
        const { wallet: walletA } = await client.fundWallet();
        const { wallet: walletB } = await client.fundWallet();
        const { wallet: walletC } = await client.fundWallet();
        log(`Holder A: ${walletA.address}`);
        log(`Holder B: ${walletB.address}`);
        log(`Holder C: ${walletC.address}`);
        log('\n=== Creating MPT issuance ===');
        const issuer = await mptIssuer_1.MPTIssuer.create(client, issuerWallet, {
            assetScale: 0,
            maximumAmount: '1000000000',
            transferable: true,
        });
        log(`Issuance ID: ${issuer.issuanceId}`);
        const issuanceState = await issuer.getIssuanceState();
        assertBool(issuanceState.requiresAuth, true, 'issuance.requiresAuth');
        assertBool(issuanceState.canClawback, true, 'issuance.canClawback');
        assertBool(issuanceState.canLock, true, 'issuance.canLock');
        assertBool(issuanceState.globallyLocked, false, 'issuance.globallyLocked (initial)');
        log('\n=== Onboarding holders (opt-in + issuer approval = allowlist) ===');
        for (const [label, wallet] of [
            ['A', walletA],
            ['B', walletB],
            ['C', walletC],
        ]) {
            await (0, mptIssuer_1.optInToIssuance)(client, wallet, issuer.issuanceId);
            await issuer.approveHolder(wallet.address);
            const state = await issuer.getHolderState(wallet.address);
            assertBool(state.authorized, true, `holder ${label}.authorized after approval`);
            log(`Holder ${label} opted in and approved.`);
        }
        log('\n=== Allowlist enforcement: an un-approved address cannot receive the token ===');
        const { wallet: strangerWallet } = await client.fundWallet();
        await expectRejected('payment to a non-allowlisted stranger', () => issuer.send(strangerWallet.address, '1'));
        log('\n=== Distributing tokens ===');
        await issuer.send(walletA.address, '500');
        await issuer.send(walletB.address, '1000');
        await issuer.send(walletC.address, '200');
        assertEqual(await issuer.getBalance(walletA.address), '500', 'A.balance after distribution');
        assertEqual(await issuer.getBalance(walletB.address), '1000', 'B.balance after distribution');
        assertEqual(await issuer.getBalance(walletC.address), '200', 'C.balance after distribution');
        log('\n=== Per-holder freeze: freeze A, prove A cannot transfer to another holder, then unfreeze ===');
        await issuer.freezeHolder(walletA.address);
        let stateA = await issuer.getHolderState(walletA.address);
        assertBool(stateA.locked, true, 'A.locked after freeze');
        await expectRejected('peer transfer from frozen holder A to holder B', () => peerPayment(client, walletA, walletB.address, issuer.issuanceId, '1'));
        await issuer.unfreezeHolder(walletA.address);
        stateA = await issuer.getHolderState(walletA.address);
        assertBool(stateA.locked, false, 'A.locked after unfreeze');
        assertEqual(stateA.balance, '500', 'A.balance unaffected by freeze/unfreeze');
        log('\n=== Global freeze: lock the whole issuance, prove peer transfers are blocked, then unlock ===');
        await issuer.globalFreeze();
        let globalState = await issuer.getIssuanceState();
        assertBool(globalState.globallyLocked, true, 'issuance.globallyLocked after globalFreeze');
        await expectRejected('peer transfer from A to B while globally frozen', () => peerPayment(client, walletA, walletB.address, issuer.issuanceId, '1'));
        await issuer.globalUnfreeze();
        globalState = await issuer.getIssuanceState();
        assertBool(globalState.globallyLocked, false, 'issuance.globallyLocked after globalUnfreeze');
        assertEqual(await issuer.getBalance(walletA.address), '500', 'A.balance unaffected by global freeze/unfreeze');
        assertEqual(await issuer.getBalance(walletB.address), '1000', 'B.balance unaffected by global freeze/unfreeze');
        log('\n=== Clawback: claw back 300 from B, then freeze B (left frozen) ===');
        await issuer.clawback(walletB.address, '300');
        assertEqual(await issuer.getBalance(walletB.address), '700', 'B.balance after clawback');
        await issuer.freezeHolder(walletB.address);
        const stateB = await issuer.getHolderState(walletB.address);
        assertBool(stateB.locked, true, 'B.locked (left frozen)');
        assertEqual(stateB.balance, '700', 'B.balance at end');
        log('\n=== Ban: clawback C in full, revoke authorization, prove C cannot receive again ===');
        await issuer.ban(walletC.address);
        const stateC = await issuer.getHolderState(walletC.address);
        assertEqual(stateC.balance, '0', 'C.balance after ban');
        assertBool(stateC.authorized, false, 'C.authorized after ban');
        await expectRejected('payment to banned holder C', () => issuer.send(walletC.address, '1'));
        log('\n=== Final state check ===');
        const finalA = await issuer.getHolderState(walletA.address);
        const finalB = await issuer.getHolderState(walletB.address);
        const finalC = await issuer.getHolderState(walletC.address);
        assertEqual(finalA.balance, '500', 'final A.balance');
        assertBool(finalA.locked, false, 'final A.locked');
        assertEqual(finalB.balance, '700', 'final B.balance');
        assertBool(finalB.locked, true, 'final B.locked');
        assertEqual(finalC.balance, '0', 'final C.balance');
        assertBool(finalC.authorized, false, 'final C.authorized');
        const finalIssuance = await issuer.getIssuanceState();
        assertBool(finalIssuance.globallyLocked, false, 'final issuance.globallyLocked');
        const result = {
            issuanceId: issuer.issuanceId,
            holders: {
                A: walletA.address,
                B: walletB.address,
                C: walletC.address,
            },
        };
        const outPath = path_1.default.join(__dirname, '..', 'result.json');
        (0, fs_1.writeFileSync)(outPath, JSON.stringify(result, null, 2) + '\n');
        log(`\nWrote ${outPath}`);
        log(JSON.stringify(result, null, 2));
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    // eslint-disable-next-line no-console -- demo script output
    console.error('\nDemo failed:', error);
    process.exitCode = 1;
});
//# sourceMappingURL=demo.js.map