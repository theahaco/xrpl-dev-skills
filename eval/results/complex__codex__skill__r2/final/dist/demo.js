import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { Client, Wallet } from 'xrpl';
import { FileStore, atomicJson } from './store.js';
import { LedgerFailure, MptIssuer, TESTNET, TransactionExecutor, walletSigner } from './issuer.js';
import { ISSUER_ADDRESS, verify } from './verify.js';
const seed = process.env.ISSUER_SEED;
if (!seed)
    throw new Error('Set ISSUER_SEED in the environment (testnet only)');
const issuerWallet = Wallet.fromSeed(seed);
assert.equal(issuerWallet.classicAddress, ISSUER_ADDRESS, 'Wrong issuer seed');
await mkdir('.private', { recursive: true, mode: 0o700 });
// Prevent two demos sharing wallet sequences. After a crash, inspect journal before removing this lock.
const processLock = await open('.private/demo.lock', 'wx', 0o600);
const client = new Client(TESTNET, { maxFeeXRP: '0.001' });
try {
    let seeds;
    try {
        seeds = JSON.parse(await readFile('.private/holders.json', 'utf8'));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        seeds = { A: Wallet.generate().seed, B: Wallet.generate().seed, C: Wallet.generate().seed };
        await writeFile('.private/holders.json', JSON.stringify(seeds), { mode: 0o600, flag: 'wx' });
    }
    const wallets = { A: Wallet.fromSeed(seeds.A), B: Wallet.fromSeed(seeds.B), C: Wallet.fromSeed(seeds.C) };
    await client.connect();
    const store = await FileStore.load('.private/journal.json');
    const executor = new TransactionExecutor(client, store);
    const signer = walletSigner(issuerWallet);
    await executor.assertTestnet();
    const info = (await client.request({ command: 'server_info' })).result.info;
    console.log('Testnet reserves:', info.validated_ledger);
    const account = (await client.request({ command: 'account_info', account: signer.address, ledger_index: 'validated' })).result.account_data;
    const reserves = info.validated_ledger;
    assert(reserves);
    assert(Number(account.Balance) / 1e6 > 9 + reserves.reserve_base_xrp + reserves.reserve_inc_xrp * (account.OwnerCount + 1) + 0.1, 'Issuer needs enough XRP for funding, reserves and fees');
    assert(3 > reserves.reserve_base_xrp + reserves.reserve_inc_xrp + 0.1, 'Holder funding below current reserve needs');
    for (const [name, wallet] of Object.entries(wallets)) {
        await executor.execute(`fund:${name}`, { TransactionType: 'Payment', Account: signer.address,
            Destination: wallet.classicAddress, Amount: '3000000' }, signer);
        console.log(`Funded ${name}: ${wallet.classicAddress}`);
    }
    const token = await MptIssuer.create(executor, signer, 'create');
    console.log('Issuance:', token.id);
    const result = { issuanceId: token.id, holders: {
            A: wallets.A.classicAddress, B: wallets.B.classicAddress, C: wallets.C.classicAddress,
        } };
    await writeFile('.private/demo-result.json', JSON.stringify(result, null, 2));
    const step = async (name, action) => {
        // Completed workflows are skipped on restart, so a finished ban is not re-approved.
        const key = `step:${name}`;
        const completed = await readFile('.private/steps.json', 'utf8').then(s => JSON.parse(s))
            .catch((error) => { if (error.code !== 'ENOENT')
            throw error; return []; });
        if (completed.includes(key))
            return;
        await action();
        completed.push(key);
        await atomicJson('.private/steps.json', completed);
        console.log(`PASS ${name}`);
    };
    const transfer = (from, to, value, key) => {
        const tx = { TransactionType: 'Payment', Account: from.classicAddress,
            Destination: to, Amount: { mpt_issuance_id: token.id, value } };
        return executor.execute(key, tx, walletSigner(from));
    };
    const denied = async (action, expected) => {
        try {
            await action();
        }
        catch (error) {
            if (error instanceof LedgerFailure && expected.includes(error.receipt.code)) {
                console.log(`Expected rejection: ${error.receipt.code} ${error.receipt.hash}`);
                return;
            }
            throw error;
        }
        throw new Error('Compliance check failed: forbidden payment succeeded');
    };
    for (const [name, wallet] of Object.entries(wallets)) {
        await step(`opt-in:${name}`, () => executor.execute(`opt-in:${name}`, {
            TransactionType: 'MPTokenAuthorize', Account: wallet.classicAddress, MPTokenIssuanceID: token.id,
        }, walletSigner(wallet)));
    }
    await step('unapproved-rejected', () => denied(() => transfer(issuerWallet, result.holders.C, '1', 'unapproved'), ['tecNO_AUTH']));
    for (const name of ['A', 'B', 'C']) {
        await step(`approve:${name}`, () => token.approve(result.holders[name], `approve:${name}`));
        const value = { A: '500', B: '1000', C: '200' }[name];
        await step(`mint:${name}`, () => token.mint(result.holders[name], value, `mint:${name}`));
    }
    await step('A-freeze', () => token.setFrozen(result.holders.A, true, 'A-freeze'));
    await step('A-cannot-send', () => denied(() => transfer(wallets.A, result.holders.B, '1', 'A-send-frozen'), ['tecLOCKED', 'tecPATH_DRY']));
    await step('A-cannot-receive', () => denied(() => transfer(wallets.B, result.holders.A, '1', 'A-receive-frozen'), ['tecLOCKED', 'tecPATH_DRY']));
    await step('A-unfreeze', () => token.setFrozen(result.holders.A, false, 'A-unfreeze'));
    await step('A-can-send', () => transfer(wallets.A, result.holders.B, '1', 'A-send-unfrozen'));
    await step('A-can-receive', () => transfer(wallets.B, result.holders.A, '1', 'A-receive-unfrozen'));
    await step('global-freeze', () => token.setGlobalFrozen(true, 'global-freeze'));
    await step('global-blocks-transfer', () => denied(() => transfer(wallets.A, result.holders.B, '1', 'global-transfer'), ['tecLOCKED', 'tecPATH_DRY']));
    await step('global-module-blocks-mint', async () => {
        await assert.rejects(token.mint(result.holders.A, '1', 'global-policy-mint'), /freeze policy/);
    });
    // Explicitly demonstrate the protocol's issuer exception, then remove the extra unit.
    await step('global-issuer-exception', () => transfer(issuerWallet, result.holders.A, '1', 'global-mint'));
    await step('global-issuer-exception-cleanup', () => token.clawback(result.holders.A, '1', 'global-exception-cleanup'));
    await step('global-unfreeze', () => token.setGlobalFrozen(false, 'global-unfreeze'));
    await step('global-transfer-restored', () => transfer(wallets.A, result.holders.B, '1', 'global-restored'));
    await step('restore-balances', () => transfer(wallets.B, result.holders.A, '1', 'global-restore-balances'));
    await step('B-freeze', () => token.setFrozen(result.holders.B, true, 'B-freeze'));
    await step('B-clawback-300-while-frozen', () => token.clawback(result.holders.B, '300', 'B-clawback'));
    await step('C-ban', () => token.ban(result.holders.C, 'C-ban'));
    await step('C-cannot-receive', () => denied(() => transfer(wallets.A, result.holders.C, '1', 'C-banned-transfer'), ['tecNO_AUTH', 'tecLOCKED', 'tecPATH_DRY']));
    await step('C-delete-empty-holding', () => executor.execute('C-delete-holding', {
        TransactionType: 'MPTokenAuthorize', Account: result.holders.C, MPTokenIssuanceID: token.id, Flags: 1,
    }, walletSigner(wallets.C)));
    await step('C-recreate-holding', () => executor.execute('C-recreate-holding', {
        TransactionType: 'MPTokenAuthorize', Account: result.holders.C, MPTokenIssuanceID: token.id,
    }, walletSigner(wallets.C)));
    await step('C-recreation-cannot-bypass-ban', () => denied(() => transfer(wallets.A, result.holders.C, '1', 'C-recreated-transfer'), ['tecNO_AUTH']));
    await step('C-issuer-cannot-mint', () => denied(() => transfer(issuerWallet, result.holders.C, '1', 'C-recreated-issuer-payment'), ['tecNO_AUTH']));
    await step('C-cannot-reapprove', async () => {
        await assert.rejects(token.approve(result.holders.C, 'C-reapprove'), /permanently banned/);
    });
    await verify(client, result);
    await writeFile('result.json', JSON.stringify(result, null, 2) + '\n');
    const journal = JSON.parse(await readFile('.private/journal.json', 'utf8'));
    await writeFile('audit.json', JSON.stringify(Object.fromEntries(Object.entries(journal.operations)
        .map(([key, operation]) => [key, operation.receipt])), null, 2) + '\n');
}
finally {
    await client.disconnect();
    await processLock.close();
    await unlink('.private/demo.lock');
}
