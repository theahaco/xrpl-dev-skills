import { Client, Wallet, xrpToDrops } from 'xrpl';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Store } from './store.js';
import { MptIssuer, payment, readHolder } from './issuer.js';
import { TESTNET, TransactionRunner, LedgerFailure, checkTestnet } from './transactions.js';
import { ISSUER, verify, type Result } from './verify.js';

const seed = process.env.ISSUER_SEED;
if (!seed) throw new Error('Set ISSUER_SEED in the environment; never put it in source files');
const issuerWallet = Wallet.fromSeed(seed);
assert.equal(issuerWallet.classicAddress, ISSUER, 'Wrong issuer seed');
const store = new Store('.state/issuer.sqlite');
const client = new Client(TESTNET, { maxFeeXRP: '0.01' });
const runner = new TransactionRunner(client, store);
type Encrypted = { salt: string; iv: string; ciphertext: string; tag: string };
function holderWallet(name: string): Wallet {
  const key = `wallet:${name}`;
  const saved = store.get<Encrypted>(key);
  if (saved) {
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(seed!, Buffer.from(saved.salt, 'hex'), 32), Buffer.from(saved.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(saved.tag, 'hex'));
    return Wallet.fromSeed(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'hex')), decipher.final()]).toString('utf8'));
  }
  const wallet = Wallet.generate();
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(seed!, salt, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(wallet.seed!, 'utf8'), cipher.final()]);
  store.put(key, { salt: salt.toString('hex'), iv: iv.toString('hex'), ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') });
  return wallet;
}
async function step(name: string, work: () => Promise<unknown>) {
  if (store.get<boolean>(`step:${name}`)) return;
  console.log(`Running ${name}`);
  await work();
  store.put(`step:${name}`, true);
}
async function rejected(name: string, work: () => Promise<unknown>, codes: string[]) {
  await step(name, async () => {
    try { await work(); } catch (error) {
      if (!(error instanceof LedgerFailure) || !codes.includes(error.receipt.code)) throw error;
      store.put(`evidence:${name}`, error.receipt); return;
    }
    throw new Error(`COMPLIANCE FAILURE: ${name} unexpectedly succeeded`);
  });
}
try {
  await client.connect();
  const environment = await checkTestnet(client);
  await writeFile('docs/research/demo-preflight.json', JSON.stringify(environment, null, 2) + '\n');
  const wallets = { A: holderWallet('A'), B: holderWallet('B'), C: holderWallet('C') };
  const reserve = environment.server.validated_ledger!;
  const account = await client.request({ command: 'account_info', account: ISSUER, ledger_index: 'validated' });
  const needed = xrpToDrops(String(15 + reserve.reserve_base_xrp + reserve.reserve_inc_xrp * (account.result.account_data.OwnerCount + 1) + 1));
  if (!store.get('step:fund:C') && BigInt(account.result.account_data.Balance) < BigInt(needed)) throw new Error('Insufficient issuer XRP for holders, reserves and fee budget');
  for (const name of ['A', 'B', 'C'] as const) {
    await step(`fund:${name}`, () => runner.send(`fund:${name}`, { TransactionType: 'Payment', Account: ISSUER,
      Destination: wallets[name].classicAddress, Amount: xrpToDrops('5') }, issuerWallet));
  }
  const issuer = await MptIssuer.create(issuerWallet, runner, store, 'create');
  const id = issuer.id;
  const result: Result = { issuanceId: id, holders: { A: wallets.A.classicAddress, B: wallets.B.classicAddress, C: wallets.C.classicAddress } };
  await writeFile('demo-accounts.json', JSON.stringify(result, null, 2) + '\n');
  for (const name of ['A', 'B', 'C'] as const) {
    await step(`opt-in:${name}`, () => runner.send(`opt-in:${name}`, { TransactionType: 'MPTokenAuthorize', Account: wallets[name].classicAddress, MPTokenIssuanceID: id }, wallets[name]));
  }
  await rejected('unauthorized:C', () => runner.send('unauthorized:C', payment(ISSUER, result.holders.C, id, '1'), issuerWallet), ['tecNO_AUTH']);
  for (const name of ['A', 'B', 'C'] as const) {
    await step(`approve:${name}`, () => issuer.approve(result.holders[name], { reference: `DEMO-KYC-${name}`, approvedBy: 'demo-simulated-kyc' }, `approve:${name}`));
  }
  for (const [name, value] of [['A', '500'], ['B', '1000'], ['C', '100']] as const) {
    await step(`issue:${name}`, () => issuer.issue(result.holders[name], value, `issue:${name}`));
  }
  await step('freeze:A', () => issuer.freezeHolder(result.holders.A, true, 'freeze:A'));
  await rejected('frozen:A:send', () => runner.send('frozen:A:send', payment(result.holders.A, result.holders.C, id, '1'), wallets.A), ['tecLOCKED']);
  await rejected('frozen:A:receive', () => runner.send('frozen:A:receive', payment(result.holders.C, result.holders.A, id, '1'), wallets.C), ['tecLOCKED']);
  // Test the protocol exception directly, then restore A after unfreezing.
  await step('frozen:A:redemption-exception', () => runner.send('frozen:A:redemption-exception', payment(result.holders.A, ISSUER, id, '1'), wallets.A));
  await step('unfreeze:A', () => issuer.freezeHolder(result.holders.A, false, 'unfreeze:A'));
  await step('restore:A', () => issuer.issue(result.holders.A, '1', 'restore:A'));
  await step('clawback:B:300', () => issuer.clawback(result.holders.B, '300', 'clawback:B:300'));
  await step('freeze:B', () => issuer.freezeHolder(result.holders.B, true, 'freeze:B'));
  await step('global:freeze', () => issuer.freezeGlobal(true, 'global:freeze'));
  await rejected('global:send', () => runner.send('global:send', payment(result.holders.A, result.holders.C, id, '1'), wallets.A), ['tecLOCKED']);
  await step('global:redemption-exception', () => runner.send('global:redemption-exception', payment(result.holders.C, ISSUER, id, '1'), wallets.C));
  await step('global:unfreeze', () => issuer.freezeGlobal(false, 'global:unfreeze'));
  // Successful transfer in each direction verifies A/global unlock; net balances unchanged.
  await step('unlocked:A-to-C', () => runner.send('unlocked:A-to-C', payment(result.holders.A, result.holders.C, id, '1'), wallets.A));
  await step('unlocked:C-to-A', () => runner.send('unlocked:C-to-A', payment(result.holders.C, result.holders.A, id, '1'), wallets.C));
  await step('ban:C', () => issuer.ban(result.holders.C, 'Demo sanctions decision', 'ban:C'));
  await rejected('banned:C:issuer-receive', () => runner.send('banned:C:issuer-receive', payment(ISSUER, result.holders.C, id, '1'), issuerWallet), ['tecNO_AUTH']);
  await rejected('banned:C:peer-receive', () => runner.send('banned:C:peer-receive', payment(result.holders.A, result.holders.C, id, '1'), wallets.A), ['tecNO_AUTH']);
  await step('banned:C:delete', () => runner.send('banned:C:delete', { TransactionType: 'MPTokenAuthorize', Account: result.holders.C, MPTokenIssuanceID: id, Flags: 1 }, wallets.C));
  await step('banned:C:recreate', () => runner.send('banned:C:recreate', { TransactionType: 'MPTokenAuthorize', Account: result.holders.C, MPTokenIssuanceID: id }, wallets.C));
  await rejected('banned:C:recreated-receive', () => runner.send('banned:C:recreated-receive', payment(result.holders.A, result.holders.C, id, '1'), wallets.A), ['tecNO_AUTH']);
  await rejected('final:B:send', () => runner.send('final:B:send', payment(result.holders.B, result.holders.A, id, '1'), wallets.B), ['tecLOCKED']);
  await rejected('final:B:receive', () => runner.send('final:B:receive', payment(result.holders.A, result.holders.B, id, '1'), wallets.A), ['tecLOCKED']);
  // Issuer-originated payments bypass native locks too. Replay the same request
  // ID if interrupted, then claw back the test unit while B remains frozen.
  await step('final:B:issuer-receive', () => runner.send('final:B:issuer-receive', payment(ISSUER, result.holders.B, id, '1'), issuerWallet));
  await step('final:B:restore', () => issuer.clawback(result.holders.B, '1', 'final:B:restore'));
  await step('global:issuer-test:freeze', () => issuer.freezeGlobal(true, 'global:issuer-test:freeze'));
  await step('global:issuer-test:receive', () => runner.send('global:issuer-test:receive', payment(ISSUER, result.holders.A, id, '1'), issuerWallet));
  await step('global:issuer-test:restore', () => issuer.clawback(result.holders.A, '1', 'global:issuer-test:restore'));
  await step('global:issuer-test:unfreeze', () => issuer.freezeGlobal(false, 'global:issuer-test:unfreeze'));
  await assert.rejects(issuer.approve(result.holders.C, { reference: 'attempt', approvedBy: 'demo' }, 'must-not-approve'), /banned/);
  await assert.rejects(issuer.freezeHolder(result.holders.C, false, 'must-not-unfreeze'), /banned/);
  assert.equal((await readHolder(client, id, result.holders.C))?.MPTAmount, '0');
  const evidence = await verify(client, result);
  await writeFile('demo-audit.json', JSON.stringify(runner.audit(), null, 2) + '\n');
  await writeFile('verification.json', JSON.stringify(evidence, null, 2) + '\n');
  await writeFile('result.json.tmp', JSON.stringify(result, null, 2) + '\n');
  await rename('result.json.tmp', 'result.json');
  console.log(`Demo complete; verified at ledger ${evidence.ledgerIndex}`);
} finally {
  await client.disconnect();
  store.close();
}
