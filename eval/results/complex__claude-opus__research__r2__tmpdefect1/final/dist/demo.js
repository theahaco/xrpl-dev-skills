/**
 * Runs every compliance control against the XRPL testnet, then writes result.json.
 *
 *   npm run demo
 *
 * Reads XRPL_WS_URL, XRPL_NETWORK_ID, ISSUER_ADDRESS and ISSUER_SEED from .env.
 */
import { open, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client, ECDSA, Wallet, encodeMPTokenMetadata, validateMPTokenMetadata, xrpToDrops } from 'xrpl';
import { JsonFileBanRegistry, MptIssuer, PolicyViolationError, optIn, sendMpt, submitAndValidate, submitOrThrow, } from './index.js';
const PROJECT_DIR = resolve(import.meta.dirname, '..');
const HOLDER_FUNDING_XRP = '3';
const METADATA = {
    ticker: 'DUSD',
    name: 'Demo Regulated USD',
    desc: 'Testnet demo of a permissioned, stablecoin-style MPT with allowlist, freeze, clawback and bans.',
    icon: 'https://example.com/dusd.png',
    asset_class: 'rwa',
    asset_subclass: 'stablecoin',
    issuer_name: 'Demo Issuer',
};
function env(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`Missing environment variable ${name} (see .env.example)`);
    return value;
}
function step(title) {
    console.log(`\n=== ${title}`);
}
function check(condition, message) {
    if (!condition)
        throw new Error(`CHECK FAILED: ${message}`);
    console.log(`  ✔ ${message}`);
}
function expectResult(tx, expected, what) {
    check(tx.resultCode === expected, `${what} → ${tx.resultCode} (expected ${expected}, tx ${tx.hash})`);
}
async function expectPolicyRefusal(promise, what) {
    try {
        await promise;
    }
    catch (err) {
        if (err instanceof PolicyViolationError) {
            check(true, `${what} refused by module: ${err.message}`);
            return;
        }
        throw err;
    }
    throw new Error(`CHECK FAILED: ${what} was expected to be refused`);
}
function expectHolder(status, expected, label) {
    for (const [key, value] of Object.entries(expected)) {
        const actual = status[key];
        check(actual === value, `${label}.${key} = ${String(actual)}`);
    }
}
async function writeFileAtomic(path, contents, mode = 0o644) {
    const tmp = `${path}.${process.pid}.tmp`;
    const file = await open(tmp, 'w', mode);
    try {
        await file.writeFile(contents, 'utf8');
        await file.sync();
    }
    finally {
        await file.close();
    }
    await rename(tmp, path);
}
async function main() {
    const networkId = Number(env('XRPL_NETWORK_ID'));
    const issuerWallet = Wallet.fromSeed(env('ISSUER_SEED'), { algorithm: ECDSA.ed25519 });
    if (issuerWallet.classicAddress !== env('ISSUER_ADDRESS')) {
        throw new Error(`ISSUER_SEED derives ${issuerWallet.classicAddress}, not ISSUER_ADDRESS`);
    }
    const metadataWarnings = validateMPTokenMetadata(encodeMPTokenMetadata(METADATA));
    if (metadataWarnings.length > 0)
        console.warn('Metadata warnings:', metadataWarnings);
    const client = new Client(env('XRPL_WS_URL'));
    await client.connect();
    try {
        if (client.networkID !== networkId)
            throw new Error(`Connected to network ${client.networkID}, expected ${networkId}`);
        console.log(`Connected to ${env('XRPL_WS_URL')} (network ${networkId}); issuer ${issuerWallet.classicAddress}`);
        const audit = (e) => console.log(`  [audit] ${e.action}${e.holder ? ` holder=${e.holder}` : ''}${e.amount ? ` amount=${e.amount}` : ''}${e.txHash ? ` tx=${e.txHash}` : ''}`);
        const issuerOptions = {
            client,
            wallet: issuerWallet,
            banRegistry: new JsonFileBanRegistry(resolve(PROJECT_DIR, 'data', `bans-${issuerWallet.classicAddress}.json`)),
            expectedNetworkId: networkId,
            onAudit: audit,
        };
        // ------------------------------------------------------------ issuance
        step('Create the MPT issuance (RequireAuth, CanLock, CanClawback, CanTransfer)');
        const issuer = await MptIssuer.createIssuance(issuerOptions, {
            assetScale: 0,
            maximumAmount: '1000000000',
            metadata: METADATA,
            allowHolderTransfers: true,
        });
        const id = issuer.issuanceId;
        console.log(`  issuance ID ${id}`);
        const created = await issuer.getIssuanceStatus();
        check(created.issuer === issuerWallet.classicAddress, 'issued from the issuer account');
        // ------------------------------------------------------------- holders
        step('Create and fund holder accounts A, B and C; each opts in to the token');
        const wallets = {
            A: Wallet.generate(ECDSA.ed25519),
            B: Wallet.generate(ECDSA.ed25519),
            C: Wallet.generate(ECDSA.ed25519),
        };
        // Save the holder keys before funding so the funded accounts are never orphaned.
        await writeFileAtomic(resolve(PROJECT_DIR, 'holders.secret.json'), JSON.stringify(Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])), null, 2) + '\n', 0o600);
        for (const [label, wallet] of Object.entries(wallets)) {
            await submitOrThrow(client, issuerWallet, {
                TransactionType: 'Payment',
                Account: issuerWallet.classicAddress,
                Destination: wallet.classicAddress,
                Amount: xrpToDrops(HOLDER_FUNDING_XRP),
            }, networkId);
            await optIn(client, wallet, id, networkId);
            console.log(`  ${label} = ${wallet.classicAddress} (funded ${HOLDER_FUNDING_XRP} XRP, opted in)`);
        }
        const { A, B, C } = wallets;
        const units = (amount) => BigInt(amount); // AssetScale is 0 in this demo
        // ----------------------------------------------------------- allowlist
        step('Allowlist: holders cannot receive the token before approval');
        await expectPolicyRefusal(issuer.issue(A.classicAddress, '500'), 'issue to unapproved A');
        expectResult(await submitAndValidate(client, issuerWallet, {
            TransactionType: 'Payment',
            Account: issuerWallet.classicAddress,
            Destination: A.classicAddress,
            Amount: { mpt_issuance_id: id, value: '500' },
        }, networkId), 'tecNO_AUTH', 'ledger rejects a direct issuer payment to unapproved A (module bypassed)');
        step('Approve A, B and C after KYC; issue A 500, B 1000, C 250');
        for (const w of [A, B, C])
            await issuer.approveHolder(w.classicAddress);
        check((await issuer.approveHolder(A.classicAddress)).status === 'noop', 'approving A again is a no-op');
        await issuer.issue(A.classicAddress, '500');
        await issuer.issue(B.classicAddress, '1000');
        await issuer.issue(C.classicAddress, '250');
        expectHolder(await issuer.getHolderStatus(A.classicAddress), { approved: true, balance: '500' }, 'A');
        expectHolder(await issuer.getHolderStatus(B.classicAddress), { approved: true, balance: '1000' }, 'B');
        expectHolder(await issuer.getHolderStatus(C.classicAddress), { approved: true, balance: '250' }, 'C');
        // --------------------------------------------------- per-holder freeze
        step('Per-holder freeze: freeze A');
        await issuer.freezeHolder(A.classicAddress);
        expectHolder(await issuer.getHolderStatus(A.classicAddress), { frozen: true }, 'A');
        expectResult(await sendMpt(client, A, B.classicAddress, id, units('10'), networkId), 'tecLOCKED', 'frozen A sends to B');
        expectResult(await sendMpt(client, B, A.classicAddress, id, units('10'), networkId), 'tecLOCKED', 'B sends to frozen A');
        await expectPolicyRefusal(issuer.issue(A.classicAddress, '1'), 'issue to frozen A');
        step('Per-holder freeze: unfreeze A');
        await issuer.unfreezeHolder(A.classicAddress);
        expectHolder(await issuer.getHolderStatus(A.classicAddress), { frozen: false }, 'A');
        expectResult(await sendMpt(client, A, B.classicAddress, id, units('10'), networkId), 'tesSUCCESS', 'unfrozen A sends 10 to B');
        expectResult(await sendMpt(client, B, A.classicAddress, id, units('10'), networkId), 'tesSUCCESS', 'B sends the 10 back to A');
        // ------------------------------------------------------- global freeze
        step('Global freeze: freeze all movement of the token');
        await issuer.freezeAll();
        check((await issuer.getIssuanceStatus()).globallyFrozen, 'issuance is globally frozen');
        expectResult(await sendMpt(client, A, B.classicAddress, id, units('1'), networkId), 'tecLOCKED', 'A sends to B while globally frozen');
        expectResult(await sendMpt(client, C, A.classicAddress, id, units('1'), networkId), 'tecLOCKED', 'C sends to A while globally frozen');
        await expectPolicyRefusal(issuer.issue(B.classicAddress, '1'), 'issue to B while globally frozen');
        step('Global freeze: lift it');
        await issuer.unfreezeAll();
        check(!(await issuer.getIssuanceStatus()).globallyFrozen, 'issuance is no longer globally frozen');
        expectResult(await sendMpt(client, A, B.classicAddress, id, units('1'), networkId), 'tesSUCCESS', 'A sends 1 to B after unfreeze');
        expectResult(await sendMpt(client, B, A.classicAddress, id, units('1'), networkId), 'tesSUCCESS', 'B sends the 1 back to A');
        // ------------------------------------------------------------ clawback
        step('Clawback: claw back 300 from B');
        const claw = await issuer.clawback(B.classicAddress, '300');
        check(claw.clawedBack === '300', `clawed back ${claw.clawedBack}`);
        expectHolder(await issuer.getHolderStatus(B.classicAddress), { balance: '700' }, 'B');
        await expectPolicyRefusal(issuer.clawback(B.classicAddress, '701'), 'claw back more than B holds');
        step('Freeze B (stays frozen)');
        await issuer.freezeHolder(B.classicAddress);
        expectResult(await sendMpt(client, B, A.classicAddress, id, units('1'), networkId), 'tecLOCKED', 'frozen B sends to A');
        // ----------------------------------------------------------------- ban
        step('Ban C');
        const report = await issuer.ban(C.classicAddress, 'Demo: sanctions screening hit');
        for (const s of report.steps) {
            console.log(`  ${s.step}: ${s.outcome.status}${s.amount ? ` (${s.amount})` : ''}${s.outcome.status === 'submitted' ? ` tx ${s.outcome.hash}` : ''}`);
        }
        expectHolder(report.finalStatus, { balance: '0', approved: false, frozen: true, banned: true }, 'C');
        await expectPolicyRefusal(issuer.approveHolder(C.classicAddress), 're-approve banned C');
        await expectPolicyRefusal(issuer.issue(C.classicAddress, '1'), 'issue to banned C');
        await expectPolicyRefusal(issuer.unfreezeHolder(C.classicAddress), 'unfreeze banned C');
        expectResult(await submitAndValidate(client, issuerWallet, {
            TransactionType: 'Payment',
            Account: issuerWallet.classicAddress,
            Destination: C.classicAddress,
            Amount: { mpt_issuance_id: id, value: '1' },
        }, networkId), 'tecNO_AUTH', 'ledger rejects a direct issuer payment to banned C (module bypassed)');
        expectResult(await sendMpt(client, A, C.classicAddress, id, units('1'), networkId), 'tecNO_AUTH', 'A sends to banned C');
        // ------------------------------------------------------- final state
        step('Verify the final ledger state');
        const reopened = await MptIssuer.open(issuerOptions, id); // re-reads and re-checks the issuance
        const final = await reopened.getIssuanceStatus();
        check(!final.globallyFrozen, 'token is not globally frozen');
        check(final.outstanding === '1200', `outstanding supply = ${final.outstanding}`);
        expectHolder(await reopened.getHolderStatus(A.classicAddress), { approved: true, frozen: false, balance: '500' }, 'A');
        expectHolder(await reopened.getHolderStatus(B.classicAddress), { approved: true, frozen: true, balance: '700' }, 'B');
        expectHolder(await reopened.getHolderStatus(C.classicAddress), { approved: false, banned: true, balance: '0' }, 'C');
        const result = {
            issuanceId: id,
            holders: { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress },
        };
        await writeFileAtomic(resolve(PROJECT_DIR, 'result.json'), JSON.stringify(result, null, 2) + '\n');
        console.log('\nWrote result.json:\n' + JSON.stringify(result, null, 2));
    }
    finally {
        await client.disconnect();
    }
}
main().catch((err) => {
    console.error('\nDemo failed:', err);
    process.exitCode = 1;
});
//# sourceMappingURL=demo.js.map