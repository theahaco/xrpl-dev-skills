import assert from 'node:assert/strict';
import { mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { Client, Wallet } from 'xrpl';
import { CAPABILITIES, MptIssuer } from './issuer.js';
import { FileStore } from './store.js';
import { LedgerFailure, Transactions } from './transactions.js';
const EXPECTED_ISSUER = 'rDXCSJkxZtZobieHcCzZeeRJw4TG4KxqfE';
async function main() {
    const seed = process.env.ISSUER_SEED;
    if (!seed)
        throw new Error('Set ISSUER_SEED in the environment');
    const issuer = Wallet.fromSeed(seed);
    assert.equal(issuer.classicAddress, EXPECTED_ISSUER);
    await mkdir('.private', { recursive: true, mode: 0o700 });
    const lock = await open('.private/demo.lock', 'wx', 0o600);
    const client = new Client('wss://s.altnet.rippletest.net:51233', { maxFeeXRP: '0.001' });
    const store = new FileStore('.private');
    try {
        await client.connect();
        const info = (await client.request({ command: 'server_info' })).result.info;
        assert.equal(info.network_id, 1);
        console.log('Testnet reserves:', info.validated_ledger);
        const tx = new Transactions(client, store);
        let secrets = await store.get('holders');
        if (!secrets) {
            secrets = { A: Wallet.generate().seed, B: Wallet.generate().seed, C: Wallet.generate().seed };
            await store.put('holders', secrets);
        }
        const holders = { A: Wallet.fromSeed(secrets.A), B: Wallet.fromSeed(secrets.B), C: Wallet.fromSeed(secrets.C) };
        async function step(name, work) {
            if (await store.get(`step-${name}`))
                return;
            console.log(name);
            const result = await work();
            await store.put(`step-${name}`, { completed: true, result: result ?? null });
        }
        for (const [name, wallet] of Object.entries(holders)) {
            await step(`fund-${name}`, () => tx.submit(`fund-${name}`, { TransactionType: 'Payment', Account: issuer.classicAddress, Destination: wallet.classicAddress, Amount: '5000000' }, issuer));
        }
        const mpt = await MptIssuer.create(tx, issuer, store, 'create-issuance');
        console.log('Issuance:', mpt.issuanceId);
        const payment = (from, to, value = '1') => ({ TransactionType: 'Payment', Account: from.classicAddress, Destination: to.classicAddress, Amount: { mpt_issuance_id: mpt.issuanceId, value } });
        async function blocked(name, from, to, codes) {
            await step(name, async () => {
                try {
                    await tx.submit(name, payment(from, to), from);
                }
                catch (error) {
                    if (error instanceof LedgerFailure) {
                        assert.ok(codes.includes(error.receipt.code), `Unexpected rejection: ${error.receipt.code}`);
                        return error.receipt;
                    }
                    throw error;
                }
                throw new Error(`Compliance failure: ${name} succeeded`);
            });
        }
        for (const [name, wallet] of Object.entries(holders)) {
            await step(`opt-in-${name}`, () => tx.submit(`opt-in-${name}`, { TransactionType: 'MPTokenAuthorize', Account: wallet.classicAddress, MPTokenIssuanceID: mpt.issuanceId }, wallet));
            await blocked(`unapproved-${name}`, issuer, wallet, ['tecNO_AUTH']);
            await step(`approve-${name}`, () => mpt.approve(`approve-${name}`, wallet.classicAddress));
        }
        await step('mint-A', () => mpt.mint('mint-A', holders.A.classicAddress, '500'));
        await step('mint-B', () => mpt.mint('mint-B', holders.B.classicAddress, '1000'));
        await step('mint-C', () => mpt.mint('mint-C', holders.C.classicAddress, '200'));
        await step('freeze-A', () => mpt.freeze('freeze-A', holders.A.classicAddress, true));
        await blocked('A-send-frozen', holders.A, holders.B, ['tecLOCKED']);
        await blocked('A-receive-frozen', holders.B, holders.A, ['tecLOCKED']);
        await step('unfreeze-A', () => mpt.freeze('unfreeze-A', holders.A.classicAddress, false));
        await step('transfer-after-unfreeze', () => tx.submit('transfer-after-unfreeze', payment(holders.A, holders.B), holders.A));
        await step('return-after-unfreeze', () => tx.submit('return-after-unfreeze', payment(holders.B, holders.A), holders.B));
        await step('clawback-B', () => mpt.clawback('clawback-B', holders.B.classicAddress, '300'));
        await step('global-freeze', () => mpt.globalFreeze('global-freeze', true));
        await blocked('global-block', holders.A, holders.B, ['tecLOCKED']);
        await step('global-unfreeze', () => mpt.globalFreeze('global-unfreeze', false));
        await step('transfer-after-global-unfreeze', () => tx.submit('transfer-after-global-unfreeze', payment(holders.A, holders.B), holders.A));
        await step('return-after-global-unfreeze', () => tx.submit('return-after-global-unfreeze', payment(holders.B, holders.A), holders.B));
        await step('freeze-B', () => mpt.freeze('freeze-B', holders.B.classicAddress, true));
        await step('ban-C', () => mpt.ban('ban-C', holders.C.classicAddress));
        await blocked('C-banned-receive', holders.A, holders.C, ['tecNO_AUTH']);
        // Prove the holder cannot evade the ban by deleting/recreating its MPToken object.
        await step('C-opt-out', () => tx.submit('C-opt-out', { TransactionType: 'MPTokenAuthorize', Account: holders.C.classicAddress, MPTokenIssuanceID: mpt.issuanceId, Flags: 1 }, holders.C));
        await step('C-opt-in-again', () => tx.submit('C-opt-in-again', { TransactionType: 'MPTokenAuthorize', Account: holders.C.classicAddress, MPTokenIssuanceID: mpt.issuanceId }, holders.C));
        await blocked('C-still-banned', holders.A, holders.C, ['tecNO_AUTH']);
        await assert.rejects(mpt.approve('C-reapprove-forbidden', holders.C.classicAddress), /banned/);
        const ledger = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result;
        const hash = ledger.ledger_hash;
        const [issuance, A, B, C] = await Promise.all([mpt.issuance(hash), mpt.holding(holders.A.classicAddress, hash), mpt.holding(holders.B.classicAddress, hash), mpt.holding(holders.C.classicAddress, hash)]);
        assert.equal(issuance.Issuer, EXPECTED_ISSUER);
        assert.equal(issuance.Flags, CAPABILITIES);
        assert.equal(issuance.OutstandingAmount, '1200');
        assert.equal(A?.MPTAmount, '500');
        assert.equal(A.Flags & 3, 2);
        assert.equal(B?.MPTAmount, '700');
        assert.equal(B.Flags & 3, 3);
        assert.equal(C?.MPTAmount, '0');
        assert.equal(C.Flags & 2, 0);
        await writeFile('verification.json', JSON.stringify({ network: 'testnet', ledgerHash: hash, ledgerIndex: ledger.ledger_index, issuance, A, B, C }, null, 2) + '\n');
        await writeFile('result.json', JSON.stringify({ issuanceId: mpt.issuanceId, holders: Object.fromEntries(Object.entries(holders).map(([name, wallet]) => [name, wallet.classicAddress])) }, null, 2) + '\n');
        const audit = await Promise.all((await readdir('.private')).filter(name => name.startsWith('step-') && name.endsWith('.json')).sort().map(async (name) => ({ step: name.slice(5, -5), ...JSON.parse(await readFile(`.private/${name}`, 'utf8')) })));
        const transactions = await Promise.all((await readdir('.private')).filter(name => name.startsWith('tx-') && name.endsWith('.json')).sort().map(async (name) => JSON.parse(await readFile(`.private/${name}`, 'utf8')).receipt));
        await writeFile('audit.json', JSON.stringify({ steps: audit, transactions: transactions.filter(Boolean) }, null, 2) + '\n');
        console.log('All controls verified. result.json, verification.json and audit.json written.');
    }
    finally {
        await client.disconnect();
        await lock.close();
        await unlink('.private/demo.lock');
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
