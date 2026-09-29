import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, Wallet, type SubmittableTransaction } from 'xrpl';
import { MptIssuer, MAX_MPT_AMOUNT, ISSUANCE_FLAGS, amount, type HolderState } from '../src/issuer.js';
import { LedgerExecutor, type Receipt } from '../src/ledger.js';
import type { Store } from '../src/store.js';

export class MemoryStore implements Store {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
}
const issuerWallet = Wallet.generate();
const holder = Wallet.generate().address;
const issuanceId = '0'.repeat(48);

test('amounts preserve full integer precision and reject coercions and overflow', () => {
  for (const value of ['1', '9007199254740993', MAX_MPT_AMOUNT]) assert.equal(amount(value), value);
  for (const value of ['0', '-1', '1.0', '1e3', ' 1', '01', '', '9223372036854775808']) assert.throws(() => amount(value));
  assert.throws(() => amount(1 as unknown as string));
});

function fixture() {
  const store = new MemoryStore();
  const ledger = new LedgerExecutor(new Client('wss://example.invalid'), store);
  const issuer = new MptIssuer(ledger, issuerWallet, issuanceId);
  let state: HolderState = { exists: true, balance: '200', authorized: true, frozen: false };
  let globalFlags = ISSUANCE_FLAGS;
  const calls: SubmittableTransaction[] = [];
  let failAt = '';
  issuer.validateConfiguration = async () => undefined;
  issuer.state = async () => structuredClone(state);
  issuer.issuance = async () => ({ LedgerEntryType: 'MPTokenIssuance', Flags: globalFlags,
    Issuer: issuerWallet.address, Sequence: 1, OutstandingAmount: state.balance,
    OwnerNode: '0', PreviousTxnID: '0'.repeat(64), PreviousTxnLgrSeq: 1, index: '0'.repeat(64) });
  ledger.transact = async (id, tx) => {
    assert.ok(await issuer.banStatus(holder) || !id.startsWith('ban'), 'persist intent before ledger mutations');
    if (id === failAt) throw new Error('network unavailable');
    calls.push(tx);
    if (tx.TransactionType === 'MPTokenAuthorize') state.authorized = tx.Flags !== 1;
    if (tx.TransactionType === 'MPTokenIssuanceSet') state.frozen = tx.Flags === 1;
    if (tx.TransactionType === 'Clawback') state.balance = '0';
    return { hash: '0'.repeat(64), ledgerIndex: 1, code: 'tesSUCCESS',
      metadata: { TransactionIndex: 0, TransactionResult: 'tesSUCCESS', AffectedNodes: [] } } satisfies Receipt;
  };
  return { issuer, calls, store, setFailure: (id: string) => { failAt = id; },
    setState: (s: HolderState) => { state = s; }, setGlobal: () => { globalFlags |= 1; } };
}

test('ban persists intent, revokes, locks, drains maximum, verifies and rejects reapproval', async () => {
  const f = fixture();
  await f.issuer.ban(holder, 'case-1', 'ban');
  assert.deepEqual(f.calls.map(t => t.TransactionType), ['MPTokenAuthorize', 'MPTokenIssuanceSet', 'Clawback']);
  assert.equal(f.calls[0]?.Flags, 1);
  assert.deepEqual(f.calls[2]?.Amount, { mpt_issuance_id: issuanceId, value: MAX_MPT_AMOUNT });
  assert.equal((await f.issuer.banStatus(holder))?.status, 'complete');
  await assert.rejects(f.issuer.approve(holder, 'approve'), /banned/);
  await assert.rejects(f.issuer.mint(holder, '1', 'mint'), /banned/);
  await assert.rejects(f.issuer.freezeHolder(holder, false, 'unfreeze'), /banned/);
  await assert.rejects(f.issuer.ban(holder, 'changed-case', 'ban'), /original ID/);
});

test('partial ban fails closed and resumes after process/module restart', async () => {
  const f = fixture();
  f.setFailure('ban:drain');
  await assert.rejects(f.issuer.ban(holder, 'case-1', 'ban'), /network/);
  assert.equal((await f.issuer.banStatus(holder))?.status, 'pending');
  assert.equal((await f.issuer.state(holder)).authorized, false);
  const restarted = new MptIssuer(f.issuer.ledger, issuerWallet, issuanceId);
  await assert.rejects(restarted.approve(holder, 'approve'), /banned/);
  f.setFailure('');
  await f.issuer.ban(holder, 'case-1', 'ban');
  assert.equal((await f.issuer.banStatus(holder))?.status, 'complete');
});

test('invalid ban ID is rejected before persisting an unresumable intent', async () => {
  const f = fixture();
  await assert.rejects(f.issuer.ban(holder, 'case-1', 'invalid id'), /Invalid operation ID/);
  assert.equal(await f.issuer.banStatus(holder), undefined);
  assert.equal(f.calls.length, 0);
});

test('ban of an absent or zero-balance holding does not submit invalid zero clawback', async () => {
  for (const exists of [false, true]) {
    const f = fixture();
    f.setState({ exists, balance: '0', authorized: false, frozen: false });
    await f.issuer.ban(holder, 'case-1', 'ban');
    assert.ok(!f.calls.some(t => t.TransactionType === 'Clawback'));
    assert.equal((await f.issuer.banStatus(holder))?.status, 'complete');
  }
});

test('mint refuses missing authorization, holder freeze, and global freeze before signing', async () => {
  for (const mode of ['unauthorized', 'holder', 'global']) {
    const f = fixture();
    f.setState({ exists: true, balance: '10', authorized: mode !== 'unauthorized', frozen: mode === 'holder' });
    if (mode === 'global') f.setGlobal();
    await assert.rejects(f.issuer.mint(holder, '1', 'mint'), /blocked/);
    assert.equal(f.calls.length, 0);
  }
});

test('failed ban postcondition never records completion', async () => {
  const f = fixture();
  f.issuer.state = async () => ({ exists: true, balance: '1', authorized: true, frozen: false });
  await assert.rejects(f.issuer.ban(holder, 'case-1', 'ban'), /incomplete/);
  assert.equal((await f.issuer.banStatus(holder))?.status, 'pending');
});

test('validated MPToken with omitted default MPTAmount decodes as zero', async () => {
  const client = { request: async () => ({ result: { validated: true,
    node: { LedgerEntryType: 'MPToken', MPTokenIssuanceID: issuanceId, Flags: 1 },
  } }) } as unknown as Client;
  const issuer = new MptIssuer(new LedgerExecutor(client, new MemoryStore()), issuerWallet, issuanceId);
  assert.deepEqual(await issuer.state(holder), { exists: true, balance: '0', authorized: false, frozen: true });
});

test('holder reads do not convert transport failures or unvalidated responses to zero balances', async () => {
  const client = { request: async () => { throw new Error('transport failed'); } } as unknown as Client;
  const issuer = new MptIssuer(new LedgerExecutor(client, new MemoryStore()), issuerWallet, issuanceId);
  await assert.rejects(issuer.state(holder), /transport/);
  client.request = async () => ({ result: { validated: false, node: { LedgerEntryType: 'MPToken', Flags: 1 } } }) as never;
  await assert.rejects(issuer.state(holder), /Invalid holder/);
});
