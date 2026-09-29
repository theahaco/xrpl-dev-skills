import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { Client, Wallet, xrpToDrops } from 'xrpl';
import { Journal } from './journal.js';
import { Ledger, TESTNET, requireSuccess, resultCode } from './ledger.js';
import { MptIssuer } from './issuer.js';
import { ISSUER, verify } from './verify.js';
const seed = process.env.ISSUER_SEED;
if (!seed)
    throw new Error('Set ISSUER_SEED using your secret manager or environment');
const issuerWallet = Wallet.fromSeed(seed);
assert.equal(issuerWallet.classicAddress, ISSUER, 'Issuer seed/address mismatch');
const journal = new Journal('.state/issuer.sqlite');
const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
const ledger = new Ledger(client, journal);
// Test holder seeds are encrypted at rest; issuer seed is never persisted.
function wallet(label) {
    const key = scryptSync(seed, `mpt-demo:${ISSUER}:${label}`, 32);
    const stored = journal.get(`wallet:${label}`);
    if (stored) {
        const b = Buffer.from(stored, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
        decipher.setAuthTag(b.subarray(12, 28));
        return Wallet.fromSeed(Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString());
    }
    const w = Wallet.generate();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(w.seed, 'utf8'), cipher.final()]);
    journal.set(`wallet:${label}`, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'));
    return w;
}
async function step(name, action) {
    if (journal.get(`step:${name}`))
        return;
    await action();
    journal.set(`step:${name}`, 'done');
}
async function submit(id, signer, tx) {
    const r = await ledger.serial(() => ledger.send(id, signer, tx));
    requireSuccess(r);
    return r;
}
try {
    await client.connect();
    const preflight = await ledger.preflight();
    writeFileSync('evidence/preflight.json', JSON.stringify(preflight, null, 2) + '\n');
    const holders = { A: wallet('A'), B: wallet('B'), C: wallet('C') };
    const { A, B, C } = holders;
    // Each account receives 5 XRP, comfortably above current base + owner reserve.
    await step('reserve-check', async () => {
        const info = (await client.request({ command: 'account_info', account: ISSUER, ledger_index: 'validated' })).result.account_data;
        const reserve = preflight.info.validated_ledger;
        const required = BigInt(xrpToDrops(String(reserve.reserve_base_xrp))) +
            BigInt(xrpToDrops(String(reserve.reserve_inc_xrp))) * BigInt(info.OwnerCount + 1) + 16000000n;
        assert.ok(BigInt(info.Balance) >= required, 'Insufficient issuer XRP for reserves, 15 XRP funding and fees');
        assert.ok(reserve.reserve_base_xrp + reserve.reserve_inc_xrp < 4, 'Holder funding must be increased');
    });
    for (const [label, w] of Object.entries(holders))
        await step(`fund-${label}`, () => submit(`fund-${label}`, issuerWallet, { TransactionType: 'Payment', Account: ISSUER, Destination: w.classicAddress, Amount: xrpToDrops('5') }));
    let issuanceId = journal.get('issuance');
    if (!issuanceId) {
        const created = await MptIssuer.create(ledger, issuerWallet, 'create');
        issuanceId = created.issuanceId;
        journal.set('issuance', issuanceId);
    }
    const token = new MptIssuer(ledger, issuerWallet, issuanceId);
    await token.assertProfile();
    for (const [label, w] of Object.entries(holders))
        await step(`optin-${label}`, () => submit(`optin-${label}`, w, { TransactionType: 'MPTokenAuthorize', Account: w.classicAddress, MPTokenIssuanceID: issuanceId }));
    async function denied(id, from, to, codes) {
        await step(id, async () => {
            const r = await ledger.serial(() => ledger.send(id, from, token.payment(from.classicAddress, to.classicAddress, '1')));
            assert.ok(codes.includes(resultCode(r)), `${id}: expected ${codes}, got ${resultCode(r)}`);
        });
    }
    await denied('unapproved-C', issuerWallet, C, ['tecNO_AUTH']);
    for (const [label, w] of Object.entries(holders))
        await step(`approve-${label}`, () => token.approve(`approve-${label}`, w.classicAddress, `demo-kyc-${label}`));
    for (const [label, value] of [['A', '500'], ['B', '1000'], ['C', '200']])
        await step(`mint-${label}`, () => token.mint(`mint-${label}`, holders[label].classicAddress, value));
    await step('peer-A-B', () => submit('peer-A-B', A, token.payment(A.classicAddress, B.classicAddress, '1')));
    await step('peer-B-A', () => submit('peer-B-A', B, token.payment(B.classicAddress, A.classicAddress, '1')));
    await step('freeze-A', () => token.freeze('freeze-A', A.classicAddress));
    await denied('frozen-A-send', A, B, ['tecLOCKED', 'tecPATH_DRY']);
    await denied('frozen-A-receive', B, A, ['tecLOCKED', 'tecPATH_DRY']);
    // Native locks exempt issuer-originated payments. Record this protocol limitation,
    // restore the probe amount, and test the issuer module's additional policy gate.
    await step('frozen-A-issuer-exception', () => submit('frozen-A-issuer-send', issuerWallet, token.payment(ISSUER, A.classicAddress, '1')));
    await step('restore-issuer-probe', () => token.clawback('restore-issuer-probe', A.classicAddress, '1'));
    if (!journal.get('step:unfreeze-A'))
        await assert.rejects(token.mint('blocked-frozen-A-mint', A.classicAddress, '1'), /unlocked/);
    await denied('frozen-A-redeem', A, issuerWallet, ['tecNO_PERMISSION']);
    await step('unfreeze-A', () => token.freeze('unfreeze-A', A.classicAddress, false));
    await step('unfrozen-A-send', () => submit('unfrozen-A-send', A, token.payment(A.classicAddress, B.classicAddress, '1')));
    await step('unfrozen-A-receive', () => submit('unfrozen-A-receive', B, token.payment(B.classicAddress, A.classicAddress, '1')));
    await step('clawback-B', () => token.clawback('clawback-B', B.classicAddress, '300'));
    await step('freeze-B', () => token.freeze('freeze-B', B.classicAddress));
    await denied('frozen-B-send', B, A, ['tecLOCKED', 'tecPATH_DRY']);
    await denied('frozen-B-receive', A, B, ['tecLOCKED', 'tecPATH_DRY']);
    await step('global-freeze', () => token.globalFreeze('global-freeze'));
    await denied('global-peer', A, C, ['tecLOCKED', 'tecPATH_DRY']);
    if (!journal.get('step:global-unfreeze'))
        await assert.rejects(token.mint('blocked-global-mint', A.classicAddress, '1'), /unlocked/);
    await denied('global-redeem', A, issuerWallet, ['tecNO_PERMISSION']);
    await step('global-unfreeze', () => token.globalFreeze('global-unfreeze', false));
    await step('global-restored-A-C', () => submit('global-restored-A-C', A, token.payment(A.classicAddress, C.classicAddress, '1')));
    await step('global-restored-C-A', () => submit('global-restored-C-A', C, token.payment(C.classicAddress, A.classicAddress, '1')));
    await step('ban-C', () => token.ban('ban-C', C.classicAddress, 'demo-compliance-ban'));
    await denied('banned-C-issuer', issuerWallet, C, ['tecNO_AUTH', 'tecLOCKED', 'tecPATH_DRY']);
    await denied('banned-C-peer', A, C, ['tecNO_AUTH', 'tecLOCKED', 'tecPATH_DRY']);
    // Older testnet permits deleting a zero locked holding. Authorization must NOT return on recreation.
    await step('C-delete', () => submit('C-delete', C, { TransactionType: 'MPTokenAuthorize', Account: C.classicAddress, MPTokenIssuanceID: issuanceId, Flags: 1 }));
    await step('C-reoptin', () => submit('C-reoptin', C, { TransactionType: 'MPTokenAuthorize', Account: C.classicAddress, MPTokenIssuanceID: issuanceId }));
    await denied('banned-C-recreated-issuer', issuerWallet, C, ['tecNO_AUTH']);
    await denied('banned-C-recreated-peer', A, C, ['tecNO_AUTH']);
    await assert.rejects(token.approve('forbidden-approve-C', C.classicAddress, 'demo-kyc-C'), /banned/);
    await assert.rejects(token.freeze('forbidden-unfreeze-C', C.classicAddress, false), /banned/);
    await assert.rejects(token.mint('forbidden-mint-C', C.classicAddress, '1'), /banned/);
    const result = { issuanceId, holders: { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress } };
    const final = await verify(client, result);
    writeFileSync('evidence/verification.json', JSON.stringify(final, null, 2) + '\n');
    const transactions = journal.db.prepare('SELECT id,hash,result FROM tx ORDER BY rowid').all().map(row => ({ id: row.id, hash: row.hash, result: JSON.parse(String(row.result)) }));
    writeFileSync('evidence/transactions.json', JSON.stringify(transactions, null, 2) + '\n');
    writeFileSync('evidence/control-checks.json', JSON.stringify({
        verifiedAt: final.verifiedAt, ledgerHash: final.ledgerHash,
        allowlist: 'Unapproved issuer payment rejected on-ledger',
        individualFreeze: 'Peer sends/receipts rejected; redemption rejected by DepositAuth; mint rejected by backend',
        globalFreeze: 'Peer payment rejected; redemption rejected by DepositAuth; mint rejected by backend',
        issuerException: 'Raw issuer payment bypassed holder lock; one-token probe was clawed back',
        ban: 'C drained and revoked; deletion/recreation did not restore authorization; backend reapproval rejected',
        backendPolicyRequired: true,
    }, null, 2) + '\n');
    writeFileSync('result.json.tmp', JSON.stringify(result, null, 2) + '\n');
    renameSync('result.json.tmp', 'result.json');
    console.log(`All controls verified at ledger ${final.ledgerIndex}; result.json written.`);
}
finally {
    await client.disconnect();
    journal.close();
}
