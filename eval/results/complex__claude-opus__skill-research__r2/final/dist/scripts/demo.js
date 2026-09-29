"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * End-to-end demo of every issuer compliance control on XRPL testnet.
 *
 * It creates a new issuance from the configured issuer account and three new
 * holder accounts (A, B, C), then exercises the allowlist, per-holder freeze,
 * global freeze, clawback and ban. Every control is checked twice: the
 * issuer module must refuse the forbidden operation, and the ledger itself
 * must reject a transaction that bypasses the module. The demo ends by
 * checking the final ledger state and writing result.json.
 *
 * Usage: npm run demo   (reads .env; see .env.example)
 */
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const xrpl_1 = require("xrpl");
const index_js_1 = require("../src/index.js");
const ROOT = process.cwd();
const TESTNET_NETWORK_ID = 1;
/** XRP sent to each new holder: 1 XRP base reserve + 0.2 XRP per MPToken + fees, with headroom. */
const HOLDER_FUNDING_XRP = '3';
/**
 * Scale 0: one base unit is one token, so "holds 500" means an on-ledger
 * MPTAmount of "500". The module supports any scale; a production
 * stablecoin would typically use 2 or 6.
 */
const ASSET_SCALE = 0;
const logger = {
    info: (event, fields) => {
        if (event.startsWith('tx.validated')) {
            console.log(`      ✓ ${String(fields?.['type'])} ${String(fields?.['hash'])}`);
        }
    },
    warn: (event, fields) => {
        if (event === 'tx.failed') {
            console.log(`      ✗ ${String(fields?.['type'])} ${String(fields?.['result'])} ${String(fields?.['hash'])}`);
        }
        else {
            console.warn(`      ! ${event}`, fields);
        }
    },
};
let stepNumber = 0;
function step(title) {
    stepNumber += 1;
    console.log(`\n[${stepNumber}] ${title}`);
}
function check(condition, message) {
    if (!condition) {
        throw new Error(`CHECK FAILED: ${message}`);
    }
    console.log(`      ✔ ${message}`);
}
/** Expects the issuer module to refuse the operation before anything is submitted. */
async function expectRefused(operation, code, what) {
    try {
        await operation;
    }
    catch (error) {
        if (error instanceof index_js_1.ComplianceError && error.code === code) {
            console.log(`      ✔ module refused ${what} (${code})`);
            return;
        }
        throw error;
    }
    throw new Error(`CHECK FAILED: expected module to refuse ${what} with ${code}, but it succeeded`);
}
/** Expects the ledger to reject a transaction with a specific `tec` code in a validated ledger. */
async function expectLedgerRejects(operation, code, what) {
    try {
        await operation;
    }
    catch (error) {
        if (error instanceof index_js_1.TransactionFailedError && error.resultCode === code && error.validated) {
            console.log(`      ✔ ledger rejected ${what} (${code})`);
            return;
        }
        throw error;
    }
    throw new Error(`CHECK FAILED: expected ledger to reject ${what} with ${code}, but it succeeded`);
}
function describeHolder(name, h) {
    return `${name} ${h.address}: balance=${h.balance} approved=${h.approved} frozen=${h.frozen} banned=${h.banned}`;
}
async function fundAccount(submitter, destination) {
    await submitter.submit({
        TransactionType: 'Payment',
        Account: submitter.address,
        Destination: destination,
        Amount: (0, xrpl_1.xrpToDrops)(HOLDER_FUNDING_XRP),
    });
}
async function xrpBalance(client, address) {
    const info = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' });
    return String((0, xrpl_1.dropsToXrp)(info.result.account_data.Balance));
}
async function main() {
    const config = (0, index_js_1.loadXrplConfig)();
    if (config.networkId !== TESTNET_NETWORK_ID) {
        throw new Error('The demo only runs against testnet (XRPL_NETWORK_ID=1)');
    }
    const issuerWallet = (0, index_js_1.loadIssuerWallet)();
    const client = await (0, index_js_1.connectClient)(config);
    try {
        await run(client, issuerWallet);
    }
    finally {
        await client.disconnect();
    }
}
async function run(client, issuerWallet) {
    const issuerAddress = issuerWallet.classicAddress;
    console.log(`Issuer ${issuerAddress} on ${client.url}, ${await xrpBalance(client, issuerAddress)} XRP`);
    // Raw issuer-account submitter, used only to fund holders and to send
    // transactions that deliberately bypass the module's guards, to show the
    // ledger itself enforces each control. Every call in this script is awaited
    // in turn, so it never races with the module's own submitter.
    const rawIssuer = new index_js_1.TransactionSubmitter(client, issuerWallet, { logger });
    // ------------------------------------------------------------------------
    step('Create holder accounts A, B, C and fund them from the issuer');
    const wallets = { A: xrpl_1.Wallet.generate(), B: xrpl_1.Wallet.generate(), C: xrpl_1.Wallet.generate() };
    // Save the holder keys before funding, so the XRP is never unreachable.
    const secretsDir = (0, node_path_1.join)(ROOT, '.secrets');
    await (0, promises_1.mkdir)(secretsDir, { recursive: true, mode: 0o700 });
    const secretsPath = (0, node_path_1.join)(secretsDir, 'holders.json');
    const saveSecrets = async (issuanceId) => {
        const holders = Object.fromEntries(Object.entries(wallets).map(([name, w]) => [name, { address: w.classicAddress, seed: w.seed }]));
        await (0, promises_1.writeFile)(secretsPath, `${JSON.stringify({ issuanceId, holders }, null, 2)}\n`, { mode: 0o600 });
        await (0, promises_1.chmod)(secretsPath, 0o600);
    };
    await saveSecrets();
    for (const [name, wallet] of Object.entries(wallets)) {
        console.log(`    ${name}: ${wallet.classicAddress}`);
        await fundAccount(rawIssuer, wallet.classicAddress);
    }
    // ------------------------------------------------------------------------
    step('Create the MPT issuance with RequireAuth, CanLock, CanClawback, CanTransfer');
    const banList = new index_js_1.JsonFileBanList((0, node_path_1.join)(ROOT, 'state', 'ban-list.json'));
    const issuer = await index_js_1.MptIssuer.createIssuance(client, issuerWallet, {
        assetScale: ASSET_SCALE,
        maximumAmount: '1000000000',
        metadata: {
            ticker: 'RUSD',
            name: 'Regulated USD (Testnet)',
            desc: 'Testnet demo of a regulated stablecoin-style MPT with allowlist, freeze, clawback and ban controls.',
            icon: 'example.com/rusd.png',
            asset_class: 'rwa',
            asset_subclass: 'stablecoin',
            issuer_name: 'Example Issuer (Testnet)',
        },
    }, { banList, logger });
    const issuanceId = issuer.issuanceId;
    await saveSecrets(issuanceId);
    console.log(`    Issuance ID: ${issuanceId}`);
    const created = await issuer.getIssuance();
    check(created.requireAuth && created.canLock && created.canClawback && created.canTransfer, 'issuance has RequireAuth, CanLock, CanClawback and CanTransfer');
    check(!created.canEscrow && !created.canTrade, 'issuance has escrow and DEX trading disabled');
    const holder = {
        A: new index_js_1.MptHolder(client, wallets.A, issuanceId, ASSET_SCALE, logger),
        B: new index_js_1.MptHolder(client, wallets.B, issuanceId, ASSET_SCALE, logger),
        C: new index_js_1.MptHolder(client, wallets.C, issuanceId, ASSET_SCALE, logger),
    };
    const addr = { A: holder.A.address, B: holder.B.address, C: holder.C.address };
    const balanceOf = async (name) => (await issuer.getHolder(addr[name])).balance;
    // ------------------------------------------------------------------------
    step('Allowlist: holders opt in; unapproved holders cannot receive');
    for (const name of ['A', 'B', 'C']) {
        await holder[name].optIn();
    }
    await expectRefused(issuer.issue(addr.A, '1'), 'HOLDER_NOT_APPROVED', 'issuing to unapproved A');
    await expectLedgerRejects(rawIssuer.submit({
        TransactionType: 'Payment',
        Account: issuerAddress,
        Destination: addr.A,
        Amount: { mpt_issuance_id: issuanceId, value: '1' },
    }), 'tecNO_AUTH', 'direct payment to unapproved A');
    step('Allowlist: approve A, B, C after KYC and issue tokens');
    for (const name of ['A', 'B', 'C']) {
        await issuer.approveHolder(addr[name]);
    }
    check((await issuer.approveHolder(addr.A)).changed === false, 're-approving A is a no-op');
    await issuer.issue(addr.A, '500');
    await issuer.issue(addr.B, '1000');
    await issuer.issue(addr.C, '200');
    check((await balanceOf('A')) === '500', 'A holds 500');
    check((await balanceOf('B')) === '1000', 'B holds 1000');
    check((await balanceOf('C')) === '200', 'C holds 200');
    // ------------------------------------------------------------------------
    step('Per-holder freeze: freeze A');
    await issuer.freezeHolder(addr.A);
    check((await issuer.getHolder(addr.A)).frozen, 'A is frozen');
    await expectLedgerRejects(holder.A.send(addr.C, '10'), 'tecLOCKED', 'frozen A sending to C');
    await expectLedgerRejects(holder.C.send(addr.A, '10'), 'tecLOCKED', 'C sending to frozen A');
    await expectRefused(issuer.issue(addr.A, '10'), 'HOLDER_FROZEN', 'issuing to frozen A');
    await holder.C.send(addr.B, '1').then(() => holder.B.send(addr.C, '1'));
    console.log('      ✔ other holders (B <-> C) can still transact');
    step('Per-holder freeze: unfreeze A');
    await issuer.unfreezeHolder(addr.A);
    check(!(await issuer.getHolder(addr.A)).frozen, 'A is no longer frozen');
    await holder.A.send(addr.C, '50');
    await holder.C.send(addr.A, '50');
    console.log('      ✔ A can send and receive again (A -> C 50, C -> A 50)');
    check((await balanceOf('A')) === '500', 'A still holds 500');
    // ------------------------------------------------------------------------
    step('Global freeze: freeze all movement of the token');
    await issuer.freezeAll();
    check((await issuer.getIssuance()).globallyFrozen, 'token is globally frozen');
    await expectLedgerRejects(holder.B.send(addr.C, '10'), 'tecLOCKED', 'B sending to C during global freeze');
    await expectLedgerRejects(holder.C.send(addr.A, '10'), 'tecLOCKED', 'C sending to A during global freeze');
    await expectRefused(issuer.issue(addr.B, '10'), 'GLOBALLY_FROZEN', 'issuing during global freeze');
    step('Global freeze: lift the freeze');
    await issuer.unfreezeAll();
    check(!(await issuer.getIssuance()).globallyFrozen, 'token is no longer globally frozen');
    await holder.C.send(addr.A, '25');
    await holder.A.send(addr.C, '25');
    console.log('      ✔ transfers work again (C -> A 25, A -> C 25)');
    // ------------------------------------------------------------------------
    step('Clawback: claw back 300 from B');
    const claw = await issuer.clawback(addr.B, '300');
    check(claw.clawedBack === '300', 'metadata shows 300 clawed back');
    check((await balanceOf('B')) === '700', 'B holds 700');
    step('Per-holder freeze: freeze B (stays frozen)');
    await issuer.freezeHolder(addr.B);
    check((await issuer.getHolder(addr.B)).frozen, 'B is frozen');
    await expectLedgerRejects(holder.B.send(addr.A, '1'), 'tecLOCKED', 'frozen B sending to A');
    // ------------------------------------------------------------------------
    step('Ban: ban C');
    const ban = await issuer.ban(addr.C, 'Demo: address flagged by compliance');
    check(ban.clawedBack === '200', 'ban clawed back all 200 of C');
    const bannedC = await issuer.getHolder(addr.C);
    check(bannedC.banned && bannedC.balanceBaseUnits === 0n && !bannedC.approved, 'C is banned, holds 0, not approved');
    await expectRefused(issuer.issue(addr.C, '1'), 'HOLDER_BANNED', 'issuing to banned C');
    await expectRefused(issuer.approveHolder(addr.C), 'HOLDER_BANNED', 're-approving banned C');
    await expectRefused(issuer.unfreezeHolder(addr.C), 'HOLDER_BANNED', 'unfreezing banned C');
    await expectLedgerRejects(rawIssuer.submit({
        TransactionType: 'Payment',
        Account: issuerAddress,
        Destination: addr.C,
        Amount: { mpt_issuance_id: issuanceId, value: '1' },
    }), 'tecNO_AUTH', 'direct issuer payment to banned C');
    await expectLedgerRejects(holder.A.send(addr.C, '1'), 'tecNO_AUTH', 'A sending to banned C');
    step('Ban: C tries to evade by deleting and re-creating its MPToken');
    try {
        await holder.C.optOut();
        console.log('      C deleted its locked, empty MPToken (allowed on testnet: fixCleanup3_4_0 is not enabled)');
        await holder.C.optIn();
        console.log('      C re-created its MPToken; it starts unapproved');
        await expectLedgerRejects(holder.A.send(addr.C, '1'), 'tecNO_AUTH', 'A sending to C after re-opt-in');
    }
    catch (error) {
        if (error instanceof index_js_1.TransactionFailedError && error.resultCode === 'tecNO_PERMISSION') {
            console.log('      ✔ ledger refused to delete banned C\'s locked MPToken (tecNO_PERMISSION)');
        }
        else {
            throw error;
        }
    }
    const reenforced = await issuer.enforceBans();
    console.log(`      enforceBans() re-applied ${reenforced.filter((r) => r.changed).length} ban(s)`);
    const finalC = await issuer.getHolder(addr.C);
    check(finalC.balanceBaseUnits === 0n && !finalC.approved && finalC.frozen, 'C holds 0, is unapproved and frozen');
    // ------------------------------------------------------------------------
    step('Verify final ledger state');
    const final = {
        issuance: await issuer.getIssuance(),
        A: await issuer.getHolder(addr.A),
        B: await issuer.getHolder(addr.B),
        C: await issuer.getHolder(addr.C),
    };
    for (const name of ['A', 'B', 'C']) {
        console.log(`    ${describeHolder(name, final[name])}`);
    }
    console.log(`    Issuance: outstanding=${final.issuance.outstandingAmount} globallyFrozen=${final.issuance.globallyFrozen}`);
    check(final.issuance.issuer === issuerAddress, 'token is issued by the issuer account');
    check(final.issuance.requireAuth && final.issuance.canLock && final.issuance.canClawback && final.issuance.canTransfer, 'all controls are available on the issuance');
    check(!final.issuance.globallyFrozen, 'token is not globally frozen');
    check(final.A.approved && !final.A.frozen && final.A.balance === '500', 'A: approved, not frozen, holds 500');
    check(final.B.approved && final.B.frozen && final.B.balance === '700', 'B: approved, frozen, holds 700');
    check(final.C.banned && !final.C.approved && final.C.balance === '0', 'C: banned, not approved, holds 0');
    check(final.issuance.outstandingAmount === '1200', 'outstanding supply is 1200 (A 500 + B 700)');
    const result = {
        issuanceId,
        holders: { A: addr.A, B: addr.B, C: addr.C },
    };
    await (0, promises_1.writeFile)((0, node_path_1.join)(ROOT, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nWrote result.json. Issuer XRP balance now ${await xrpBalance(client, issuerAddress)} XRP.`);
    console.log(`Explorer: https://testnet.xrpl.org/accounts/${issuerAddress}`);
}
main().catch((error) => {
    console.error('\nDemo failed:', error);
    process.exitCode = 1;
});
//# sourceMappingURL=demo.js.map