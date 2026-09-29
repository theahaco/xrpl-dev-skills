import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Wallet } from 'xrpl';
import {
  type AuditEvent,
  GlobalFreezeActiveError,
  HolderBannedError,
  HolderFrozenError,
  HolderNotAuthorizedError,
  HolderNotOptedInError,
  InMemoryBanRegistry,
  InsufficientHolderBalanceError,
  InvalidInputError,
  IssuanceConfigurationError,
  MptIssuer,
} from '../src/index.js';
import { FakeLedger } from './fakeLedger.js';

const issuerWallet = Wallet.generate();
const H = Wallet.generate().classicAddress;

async function setup(holder?: Partial<{ authorized: boolean; locked: boolean; balance: bigint }>) {
  const ledger = new FakeLedger();
  ledger.issuer = issuerWallet.classicAddress;
  if (holder) ledger.holders.set(H, { authorized: false, locked: false, balance: 0n, ...holder });
  const events: AuditEvent[] = [];
  const bans = new InMemoryBanRegistry();
  const issuer = await MptIssuer.connect(ledger.asClient(), issuerWallet, ledger.issuanceId, {
    banRegistry: bans,
    audit: (e) => void events.push(e),
    submitter: { pollIntervalMs: 0, timeoutMs: 1_000 },
  });
  return { ledger, issuer, events, bans };
}

test('connect verifies issuer ownership and the compliance flag policy', async () => {
  const ledger = new FakeLedger();
  const opts = { banRegistry: new InMemoryBanRegistry() };
  ledger.issuer = Wallet.generate().classicAddress;
  await assert.rejects(MptIssuer.connect(ledger.asClient(), issuerWallet, ledger.issuanceId, opts), IssuanceConfigurationError);
  ledger.issuer = issuerWallet.classicAddress;
  ledger.issuanceFlags = 0x26; // no CanClawback
  await assert.rejects(MptIssuer.connect(ledger.asClient(), issuerWallet, ledger.issuanceId, opts), /missing required/);
  ledger.issuanceFlags = 0x66 | 0x08; // + CanEscrow
  await assert.rejects(MptIssuer.connect(ledger.asClient(), issuerWallet, ledger.issuanceId, opts), /outside the compliance policy/);
  await assert.rejects(MptIssuer.connect(ledger.asClient(), issuerWallet, 'nothex', opts), InvalidInputError);
});

test('issue is refused unless holder is opted in, approved, unfrozen, unbanned and no global freeze', async () => {
  let s = await setup();
  await assert.rejects(s.issuer.issue(H, 1n), HolderNotOptedInError);
  s = await setup({ authorized: false });
  await assert.rejects(s.issuer.issue(H, 1n), HolderNotAuthorizedError);
  s = await setup({ authorized: true, locked: true });
  await assert.rejects(s.issuer.issue(H, 1n), HolderFrozenError);
  s = await setup({ authorized: true });
  s.ledger.issuanceFlags |= 1;
  await assert.rejects(s.issuer.issue(H, 1n), GlobalFreezeActiveError);
  s = await setup({ authorized: true });
  await s.bans.add({ address: H, issuanceId: s.ledger.issuanceId, reason: 'x', bannedAt: 'now' });
  await assert.rejects(s.issuer.issue(H, 1n), HolderBannedError);
  assert.equal(s.ledger.submitted.length, 0, 'nothing was signed or submitted');
  assert.equal(s.events.at(-1)?.outcome, 'rejected');
});

test('issue respects the supply cap and rejects bad input', async () => {
  const s = await setup({ authorized: true });
  await assert.rejects(s.issuer.issue(H, 1_000_001n), /supply cap/);
  await assert.rejects(s.issuer.issue(H, '1.5'), InvalidInputError);
  await assert.rejects(s.issuer.issue(issuerWallet.classicAddress, 1n), /issuer cannot be the holder/);
  await s.issuer.issue(H, 500n);
  assert.equal(s.ledger.holders.get(H)?.balance, 500n);
  assert.equal(s.events.at(-1)?.outcome, 'success');
  assert.equal(s.events.at(-1)?.amount, '500');
});

test('authorize requires KYC reference, is idempotent, and never re-approves a banned address', async () => {
  const s = await setup({ authorized: false });
  await assert.rejects(s.issuer.authorizeHolder(H, { kycReference: ' ' }), InvalidInputError);
  assert.equal((await s.issuer.authorizeHolder(H, { kycReference: 'K1' })).changed, true);
  assert.equal((await s.issuer.authorizeHolder(H, { kycReference: 'K1' })).changed, false);
  await s.issuer.banHolder(H, { reason: 'sanctions' });
  await assert.rejects(s.issuer.authorizeHolder(H, { kycReference: 'K1' }), HolderBannedError);
});

test('clawback refuses to exceed balance instead of silently clamping', async () => {
  const s = await setup({ authorized: true, balance: 100n });
  await assert.rejects(s.issuer.clawback(H, 101n, { reason: 'x' }), InsufficientHolderBalanceError);
  await s.issuer.clawback(H, 40n, { reason: 'x' });
  assert.equal(s.ledger.holders.get(H)?.balance, 60n);
});

test('freeze / unfreeze (holder and global) skip when already in the target state', async () => {
  const s = await setup({ authorized: true });
  assert.equal((await s.issuer.freezeHolder(H, { reason: 'x' })).changed, true);
  assert.equal((await s.issuer.freezeHolder(H, { reason: 'x' })).changed, false);
  assert.equal((await s.issuer.unfreezeHolder(H, { reason: 'x' })).changed, true);
  assert.equal((await s.issuer.freezeAll({ reason: 'x' })).changed, true);
  assert.equal((await s.issuer.getIssuance()).globallyFrozen, true);
  assert.equal((await s.issuer.freezeAll({ reason: 'x' })).changed, false);
  assert.equal((await s.issuer.unfreezeAll({ reason: 'x' })).changed, true);
});

test('ban records first, unauthorizes, claws back everything, verifies, and is idempotent', async () => {
  const s = await setup({ authorized: true, locked: true, balance: 250n });
  const res = await s.issuer.banHolder(H, { reason: 'sanctions' });
  assert.deepEqual(res.transactions.map((t) => t.action), ['unauthorize', 'clawback']);
  assert.equal(res.clawedBack, 250n);
  assert.equal(res.finalState.balance, 0n);
  assert.equal(res.finalState.authorized, false);
  assert.equal(res.finalState.banned, true);
  const again = await s.issuer.banHolder(H, { reason: 'sanctions' });
  assert.equal(again.transactions.length, 0);
  assert.equal(s.events.filter((e) => e.action === 'holder.ban').length, 2);
});

test('ban of an address that never opted in just records it', async () => {
  const s = await setup();
  const res = await s.issuer.banHolder(H, { reason: 'pre-emptive' });
  assert.equal(res.transactions.length, 0);
  assert.equal((await s.issuer.listBans()).length, 1);
  await assert.rejects(s.issuer.banHolder(H, { reason: '' }), InvalidInputError);
});
