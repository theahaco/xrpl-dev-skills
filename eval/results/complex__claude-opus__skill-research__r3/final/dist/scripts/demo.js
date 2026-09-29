"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Demo: exercises every compliance control of the issuer module on the
 * configured network (testnet by default), then writes result.json.
 *
 *   npm run demo
 *
 * Needs XRPL_ISSUER_SEED (and optionally XRPL_ISSUER_ADDRESS, XRPL_NETWORK) in .env.
 */
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const xrpl_1 = require("xrpl");
const index_js_1 = require("../src/index.js");
const ROOT = (0, node_path_1.resolve)(__dirname, '..', '..');
const ASSET_SCALE = 2;
const HOLDER_FUNDING_XRP = '5';
if ((0, node_fs_1.existsSync)((0, node_path_1.resolve)(ROOT, '.env')))
    process.loadEnvFile((0, node_path_1.resolve)(ROOT, '.env'));
function requireEnv(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`Missing ${name} (see .env.example)`);
    return value;
}
function step(title) {
    console.log(`\n== ${title}`);
}
function ok(message) {
    console.log(`  ✓ ${message}`);
}
function assert(condition, message) {
    if (!condition)
        throw new Error(`Assertion failed: ${message}`);
}
async function main() {
    const networkName = process.env['XRPL_NETWORK'] ?? 'testnet';
    const client = await (0, index_js_1.connect)((0, index_js_1.resolveNetwork)(networkName));
    const submitter = new index_js_1.TransactionSubmitter(client);
    const stateDir = (0, node_path_1.resolve)(ROOT, 'state');
    const secretsDir = (0, node_path_1.resolve)(ROOT, '.secrets');
    (0, node_fs_1.mkdirSync)(stateDir, { recursive: true, mode: 0o700 });
    (0, node_fs_1.mkdirSync)(secretsDir, { recursive: true, mode: 0o700 });
    try {
        const issuerWallet = (0, index_js_1.walletFromSeed)(requireEnv('XRPL_ISSUER_SEED'), process.env['XRPL_ISSUER_ADDRESS']);
        console.log(`Network: ${networkName}  Issuer: ${issuerWallet.classicAddress}`);
        const onAudit = (event) => {
            (0, node_fs_1.appendFileSync)((0, node_path_1.resolve)(stateDir, 'audit.jsonl'), `${JSON.stringify(event)}\n`);
            console.log(`  [audit] ${event.action}${event.holder ? ` ${event.holder}` : ''}${event.amount ? ` ${event.amount}` : ''} tx=${event.txHash ?? '-'}`);
        };
        const deps = { client, submitter, banRegistry: new index_js_1.FileBanRegistry((0, node_path_1.resolve)(stateDir, 'bans.json')), onAudit };
        /** Submits a transaction directly (bypassing the module) and requires the ledger to reject it with `code`. */
        const expectLedgerRejects = async (label, wallet, tx, code) => {
            const outcome = await submitter.submitForOutcome(wallet, tx);
            assert(outcome.resultCode === code, `${label}: expected ${code}, got ${outcome.resultCode} (${outcome.hash})`);
            ok(`${label} -> ledger rejected with ${code} (${outcome.hash})`);
        };
        /** Requires the module to refuse the action before anything is submitted. */
        const expectModuleRefuses = async (label, action) => {
            try {
                await action();
            }
            catch (error) {
                if (error instanceof index_js_1.ComplianceViolationError) {
                    ok(`${label} -> module refused: ${error.message}`);
                    return;
                }
                throw error;
            }
            throw new Error(`${label}: expected the module to refuse`);
        };
        const expectHolder = async (name, address, expected) => {
            const state = await issuer.getHolderState(address);
            for (const [key, value] of Object.entries(expected)) {
                assert(state[key] === value, `${name}.${key}: expected ${String(value)}, got ${String(state[key])}`);
            }
            ok(`${name}: balance=${state.balance} approved=${state.approved} frozen=${state.frozen} banned=${state.banned}`);
        };
        const units = (amount) => (0, index_js_1.toBaseUnits)(amount, ASSET_SCALE).toString();
        step('1. Create the MPT issuance (RequireAuth + CanLock + CanClawback + CanTransfer)');
        const issuer = await index_js_1.MptIssuer.create(deps, issuerWallet, {
            assetScale: ASSET_SCALE,
            metadata: {
                ticker: 'RUSD',
                name: 'Regulated USD (testnet demo)',
                desc: 'Testnet demo of an allowlisted, freezable, clawback-enabled USD stablecoin.',
                icon: 'example.com/rusd-icon.png',
                asset_class: 'rwa',
                asset_subclass: 'stablecoin',
                issuer_name: 'Demo Issuer (testnet)',
            },
        });
        const id = issuer.issuanceId;
        const issuance = await issuer.getIssuanceState();
        ok(`Issuance ${id} capabilities ${JSON.stringify(issuance.capabilities)}`);
        step('2. Create and fund holder accounts A, B, C');
        const holders = {
            A: xrpl_1.Wallet.generate(xrpl_1.ECDSA.ed25519),
            B: xrpl_1.Wallet.generate(xrpl_1.ECDSA.ed25519),
            C: xrpl_1.Wallet.generate(xrpl_1.ECDSA.ed25519),
        };
        // Save the seeds first, so the funded accounts are never lost.
        (0, node_fs_1.writeFileSync)((0, node_path_1.resolve)(secretsDir, `demo-holders-${id}.json`), `${JSON.stringify(Object.fromEntries(Object.entries(holders).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])), null, 2)}\n`, { mode: 0o600 });
        const { A, B, C } = holders;
        for (const [name, wallet] of Object.entries(holders)) {
            const tx = await submitter.submit(issuerWallet, {
                TransactionType: 'Payment',
                Account: issuerWallet.classicAddress,
                Destination: wallet.classicAddress,
                Amount: (0, xrpl_1.xrpToDrops)(HOLDER_FUNDING_XRP),
            });
            ok(`${name} = ${wallet.classicAddress} funded with ${HOLDER_FUNDING_XRP} XRP (${tx.hash})`);
        }
        step('3. Holders opt in to the token');
        for (const [name, wallet] of Object.entries(holders)) {
            const tx = await (0, index_js_1.optIn)(submitter, wallet, id);
            ok(`${name} opted in (${tx.hash})`);
        }
        step('4. Allowlist: holders cannot receive before approval');
        await expectModuleRefuses('issue 1 to unapproved A', () => issuer.issue(A.classicAddress, '1'));
        await expectLedgerRejects('direct payment to unapproved A', issuerWallet, (0, index_js_1.transferTx)(issuerWallet, A.classicAddress, id, units('1')), 'tecNO_AUTH');
        step('5. Approve A, B, C (post-KYC) and issue 500 / 1000 / 100');
        for (const [name, wallet] of Object.entries(holders)) {
            await issuer.approveHolder(wallet.classicAddress, `KYC approved (${name})`);
        }
        await issuer.issue(A.classicAddress, '500', 'initial issuance');
        await issuer.issue(B.classicAddress, '1000', 'initial issuance');
        await issuer.issue(C.classicAddress, '100', 'initial issuance');
        await expectHolder('A', A.classicAddress, { balance: '500', approved: true });
        await expectHolder('B', B.classicAddress, { balance: '1000', approved: true });
        await expectHolder('C', C.classicAddress, { balance: '100', approved: true });
        step('6. Clawback: claw back 300 from B');
        const claw = await issuer.clawback(B.classicAddress, '300', 'demo: compliance clawback');
        assert(claw.clawedBack === '300', `clawed back ${claw.clawedBack}`);
        await expectHolder('B', B.classicAddress, { balance: '700' });
        step('7. Per-holder freeze: freeze A, verify A cannot send or receive, then unfreeze');
        await issuer.freezeHolder(A.classicAddress, 'demo: individual freeze');
        await expectHolder('A', A.classicAddress, { frozen: true });
        await expectLedgerRejects('frozen A sends 10 to B', A, (0, index_js_1.transferTx)(A, B.classicAddress, id, units('10')), 'tecLOCKED');
        await expectLedgerRejects('B sends 10 to frozen A', B, (0, index_js_1.transferTx)(B, A.classicAddress, id, units('10')), 'tecLOCKED');
        await expectModuleRefuses('issue 1 to frozen A', () => issuer.issue(A.classicAddress, '1'));
        await issuer.unfreezeHolder(A.classicAddress, 'demo: lift individual freeze');
        await submitter.submit(C, (0, index_js_1.transferTx)(C, A.classicAddress, id, units('25')));
        await submitter.submit(A, (0, index_js_1.transferTx)(A, C.classicAddress, id, units('25')));
        ok('after unfreeze, A received 25 from C and sent 25 back');
        await expectHolder('A', A.classicAddress, { balance: '500', frozen: false });
        step('8. Global freeze: freeze the whole token, verify transfers stop, then unfreeze');
        await issuer.freezeAll('demo: incident response');
        assert((await issuer.getIssuanceState()).globallyFrozen, 'issuance should be globally frozen');
        await expectLedgerRejects('A sends 1 to C during global freeze', A, (0, index_js_1.transferTx)(A, C.classicAddress, id, units('1')), 'tecLOCKED');
        await expectModuleRefuses('issue 1 to B during global freeze', () => issuer.issue(B.classicAddress, '1'));
        await issuer.unfreezeAll('demo: incident resolved');
        assert(!(await issuer.getIssuanceState()).globallyFrozen, 'issuance should not be globally frozen');
        await submitter.submit(A, (0, index_js_1.transferTx)(A, C.classicAddress, id, units('1')));
        await submitter.submit(C, (0, index_js_1.transferTx)(C, A.classicAddress, id, units('1')));
        ok('after global unfreeze, A and C exchanged 1 token each way');
        step('9. Ban C: record, freeze, remove from allowlist, claw back everything');
        const ban = await issuer.ban(C.classicAddress, 'demo: sanctions match');
        ok(`C banned; clawed back ${ban.clawedBack}; txs ${ban.txHashes.join(', ')}`);
        await expectHolder('C', C.classicAddress, { balance: '0', approved: false, frozen: true, banned: true });
        await expectLedgerRejects('issuer pays banned C directly', issuerWallet, (0, index_js_1.transferTx)(issuerWallet, C.classicAddress, id, units('1')), 'tecNO_AUTH');
        await expectLedgerRejects('A sends 1 to banned C', A, (0, index_js_1.transferTx)(A, C.classicAddress, id, units('1')), 'tecNO_AUTH');
        await expectModuleRefuses('re-approve banned C', () => issuer.approveHolder(C.classicAddress));
        await expectModuleRefuses('issue to banned C', () => issuer.issue(C.classicAddress, '1'));
        await expectModuleRefuses('unfreeze banned C', () => issuer.unfreezeHolder(C.classicAddress));
        step('10. Freeze B (stays frozen)');
        await issuer.freezeHolder(B.classicAddress, 'demo: individual freeze');
        await expectLedgerRejects('frozen B sends 1 to A', B, (0, index_js_1.transferTx)(B, A.classicAddress, id, units('1')), 'tecLOCKED');
        step('11. Verify final ledger state');
        const final = await issuer.getIssuanceState();
        assert(final.issuer === issuerWallet.classicAddress, 'issuer');
        assert(final.capabilities.requireAuth && final.capabilities.canLock && final.capabilities.canClawback, 'controls');
        assert(!final.globallyFrozen, 'not globally frozen');
        assert(final.outstanding === '1200', `outstanding ${final.outstanding}`);
        ok(`issuance: outstanding=${final.outstanding} globallyFrozen=${final.globallyFrozen}`);
        await expectHolder('A', A.classicAddress, { balance: '500', approved: true, frozen: false, banned: false });
        await expectHolder('B', B.classicAddress, { balance: '700', approved: true, frozen: true, banned: false });
        await expectHolder('C', C.classicAddress, { balance: '0', approved: false, banned: true });
        const result = {
            issuanceId: id,
            holders: { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress },
        };
        (0, node_fs_1.writeFileSync)((0, node_path_1.resolve)(ROOT, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
        console.log(`\nDone. Wrote result.json:\n${JSON.stringify(result, null, 2)}`);
    }
    finally {
        await client.disconnect();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
//# sourceMappingURL=demo.js.map