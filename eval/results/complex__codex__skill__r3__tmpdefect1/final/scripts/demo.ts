import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { Client, Wallet, xrpToDrops } from 'xrpl';
import { FileStore, LedgerFailure, MptIssuer, TransactionRunner, XrplLedgerReader, paymentTx, type Receipt } from '../src/index.js';
import { ENDPOINT, ISSUER, verify, type Result } from './common.js';

const seed = process.env.XRPL_ISSUER_SEED;
if (!seed) throw new Error('Set XRPL_ISSUER_SEED in the environment');
const issuerWallet = Wallet.fromSeed(seed);
assert.equal(issuerWallet.classicAddress, ISSUER, 'Wrong issuer seed');
await mkdir('.local', { recursive: true, mode: 0o700 });
const lock = await open('.local/demo.lock', 'wx', 0o600);
const client = new Client(ENDPOINT, { maxFeeXRP: '0.01', timeout: 30_000 });
try {
  // Holder secrets are encrypted at rest with a key derived from the supplied issuer secret.
  const key = Buffer.from(hkdfSync('sha256', seed, 'xrpl-testnet-demo', 'holder-wallet-backup-v1', 32));
  let seeds: string[];
  try {
    const saved = JSON.parse(await readFile('.local/holders.enc.json', 'utf8')) as { iv: string; tag: string; data: string };
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(saved.iv, 'hex'));
    cipher.setAuthTag(Buffer.from(saved.tag, 'hex'));
    seeds = JSON.parse(Buffer.concat([cipher.update(Buffer.from(saved.data, 'hex')), cipher.final()]).toString()) as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    seeds = Array.from({ length: 3 }, () => Wallet.generate().seed!);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(seeds)), cipher.final()]);
    await writeFile('.local/holders.enc.json', JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') }), { mode: 0o600, flag: 'wx' });
  }
  const wallets = seeds.map(s => Wallet.fromSeed(s));
  const [A, B, C] = wallets;
  assert.ok(A && B && C);
  await client.connect();
  const store = await FileStore.open('.local/state.json');
  const runner = new TransactionRunner(client, issuerWallet, store);
  const holderRunners = wallets.map(w => new TransactionRunner(client, w, store));
  const [aRunner, bRunner, cRunner] = holderRunners;
  assert.ok(aRunner && bRunner && cRunner);
  const ledger = new XrplLedgerReader(client);
  const audit = await store.get<Array<{ step: string; result: unknown }>>('audit') ?? [];
  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const saved = await store.get<{ result: T }>(`step:${name}`);
    if (saved) return saved.result;
    const result = await fn();
    await store.put(`step:${name}`, { result });
    audit.push({ step: name, result: result ?? null });
    await store.put('audit', audit);
    await writeFile('demo-audit.json', JSON.stringify(audit, null, 2) + '\n');
    console.log(name, result && typeof result === 'object' && 'code' in result ? result.code : 'OK');
    return result;
  }
  async function rejected(fn: () => Promise<Receipt>, codes: string[]): Promise<Receipt> {
    try { await fn(); } catch (error) {
      if (!(error instanceof LedgerFailure)) throw error;
      assert.ok(codes.includes(error.receipt.code), `Expected ${codes}; got ${error.receipt.code}`);
      return error.receipt;
    }
    throw new Error('A prohibited transaction unexpectedly succeeded');
  }
  const info = (await client.request({ command: 'server_info' })).result.info;
  assert.equal(info.network_id, 1);
  const reserve = info.validated_ledger;
  assert.ok(reserve);
  assert.ok(reserve.reserve_base_xrp + reserve.reserve_inc_xrp + 0.1 < 5, 'Holder funding insufficient for current reserves');
  await step('reserve-preflight', async () => {
    const account = (await client.request({ command: 'account_info', account: ISSUER, ledger_index: 'validated' })).result.account_data;
    assert.ok(BigInt(account.Balance) > BigInt(xrpToDrops(String(15 + reserve.reserve_base_xrp + reserve.reserve_inc_xrp * (account.OwnerCount + 1) + 1))));
    return { baseXrp: reserve.reserve_base_xrp, ownerXrp: reserve.reserve_inc_xrp, holderFundingXrp: 5 };
  });
  for (const [i, wallet] of wallets.entries()) {
    await step(`fund-${i}`, () => runner.execute(`fund-${i}`, { TransactionType: 'Payment', Account: ISSUER, Destination: wallet.classicAddress, Amount: xrpToDrops('5') }));
  }
  const id = await step('create', async () => (await MptIssuer.create(runner, ledger, store, 'create')).id);
  const issuer = new MptIssuer(id, runner, ledger, store);
  for (const [i, wallet] of wallets.entries()) {
    const holderRunner = holderRunners[i]!;
    await step(`opt-in-${i}`, () => holderRunner.execute(`opt-in-${i}`, { TransactionType: 'MPTokenAuthorize', Account: wallet.classicAddress, MPTokenIssuanceID: id }));
  }
  await step('unapproved-receipt-blocked', () => rejected(() => runner.execute('unapproved-receipt-blocked', paymentTx(id, ISSUER, C.classicAddress, '1')), ['tecNO_AUTH']));
  for (const [i, wallet] of wallets.entries()) await step(`approve-${i}`, () => issuer.approve(wallet.classicAddress, `approve-${i}`));
  await step('mint-A-500', () => issuer.mint(A.classicAddress, '500', 'mint-A-500'));
  await step('mint-B-1000', () => issuer.mint(B.classicAddress, '1000', 'mint-B-1000'));
  await step('mint-C-200', () => issuer.mint(C.classicAddress, '200', 'mint-C-200'));
  await step('transfer-A-B', () => aRunner.execute('transfer-A-B', paymentTx(id, A.classicAddress, B.classicAddress, '1')));
  await step('transfer-B-A', () => bRunner.execute('transfer-B-A', paymentTx(id, B.classicAddress, A.classicAddress, '1')));
  await step('freeze-A', () => issuer.freezeHolder(A.classicAddress, 'freeze-A'));
  await step('frozen-A-send-blocked', () => rejected(() => aRunner.execute('frozen-A-send-blocked', paymentTx(id, A.classicAddress, B.classicAddress, '1')), ['tecLOCKED']));
  await step('frozen-A-receive-blocked', () => rejected(() => bRunner.execute('frozen-A-receive-blocked', paymentTx(id, B.classicAddress, A.classicAddress, '1')), ['tecLOCKED']));
  await step('frozen-issuer-mint-exception', () => runner.execute('frozen-A-mint-blocked', paymentTx(id, ISSUER, A.classicAddress, '1')));
  await step('remove-frozen-mint-probe', () => issuer.clawback(A.classicAddress, '1', 'remove-frozen-mint-probe'));
  await step('frozen-backend-mint-guard', async () => {
    await assert.rejects(issuer.mint(A.classicAddress, '1', 'bad-frozen-mint'), /frozen/);
    return 'mint blocked by backend';
  });
  await step('frozen-redemption-exception', () => aRunner.execute('frozen-redemption-exception', paymentTx(id, A.classicAddress, ISSUER, '1')));
  await step('unfreeze-A', () => issuer.unfreezeHolder(A.classicAddress, 'unfreeze-A'));
  await step('restore-A-after-redemption', () => issuer.mint(A.classicAddress, '1', 'restore-A-after-redemption'));
  await step('freeze-global', () => issuer.freezeGlobal('freeze-global'));
  await step('global-transfer-blocked', () => rejected(() => aRunner.execute('global-transfer-blocked', paymentTx(id, A.classicAddress, B.classicAddress, '1')), ['tecLOCKED']));
  await step('global-issuer-mint-exception', () => runner.execute('global-issuer-mint-exception', paymentTx(id, ISSUER, A.classicAddress, '1')));
  await step('remove-global-mint-probe', () => issuer.clawback(A.classicAddress, '1', 'remove-global-mint-probe'));
  await step('global-backend-mint-guard', async () => {
    await assert.rejects(issuer.mint(A.classicAddress, '1', 'bad-global-mint'), /frozen/);
    return 'mint blocked by backend';
  });
  await step('global-redemption-exception', () => aRunner.execute('global-redemption-exception', paymentTx(id, A.classicAddress, ISSUER, '1')));
  await step('unfreeze-global', () => issuer.unfreezeGlobal('unfreeze-global'));
  await step('restore-A-after-global', () => issuer.mint(A.classicAddress, '1', 'restore-A-after-global'));
  await step('freeze-B', () => issuer.freezeHolder(B.classicAddress, 'freeze-B'));
  await step('clawback-B-300-while-frozen', () => issuer.clawback(B.classicAddress, '300', 'clawback-B-300'));
  await step('ban-C', () => issuer.ban(C.classicAddress, 'ban-C', 'Demo compliance ban'));
  await step('banned-C-receipt-blocked', () => rejected(() => aRunner.execute('banned-C-receipt-blocked', paymentTx(id, A.classicAddress, C.classicAddress, '1')), ['tecNO_AUTH', 'tecLOCKED']));
  await step('banned-C-mint-blocked', () => rejected(() => runner.execute('banned-C-mint-blocked', paymentTx(id, ISSUER, C.classicAddress, '1')), ['tecNO_AUTH', 'tecLOCKED']));
  await step('ban-backend-guards', async () => {
    await assert.rejects(issuer.approve(C.classicAddress, 'bad-reapprove'), /banned/);
    await assert.rejects(issuer.unfreezeHolder(C.classicAddress, 'bad-unlock'), /banned/);
    await assert.rejects(issuer.mint(C.classicAddress, '1', 'bad-mint'), /banned/);
    return 'approval, unlock and mint rejected';
  });
  const result: Result = { issuanceId: id, holders: { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress } };
  const evidence = await verify(client, result);
  const journal = JSON.parse(await readFile('.local/state.json', 'utf8')) as Record<string, { receipt?: Receipt }>;
  const receipts = Object.entries(journal)
    .filter(([key, record]) => key.startsWith('tx:') && record.receipt)
    .map(([operation, record]) => ({ operation, ...record.receipt }));
  await writeFile('transaction-receipts.json', JSON.stringify(receipts, null, 2) + '\n');
  await writeFile('verification.json', JSON.stringify(evidence, null, 2) + '\n');
  await writeFile('result.json', JSON.stringify(result, null, 2) + '\n');
  console.log(`Verified at ledger ${evidence.ledgerIndex}; result.json written`);
} finally {
  if (client.isConnected()) await client.disconnect();
  await lock.close();
  await unlink('.local/demo.lock');
}
