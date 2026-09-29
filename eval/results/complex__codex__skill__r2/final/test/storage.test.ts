import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { FileStore } from '../src/storage.js';
import { Wallet } from 'xrpl';
test('durable bans and unsettled transactions survive adapter restart', async () => {
  await mkdir('.runtime', { recursive: true });
  const directory = await mkdtemp('.runtime/test-');
  try {
    const path = `${directory}/events.jsonl`, store = new FileStore(path);
    const wallet = Wallet.generate();
    await store.ban('issuance', wallet.classicAddress);
    await store.prepared({ hash: 'hash', blob: 'blob', lastLedgerSequence: 10, transaction: { TransactionType: 'MPTokenAuthorize', Account: wallet.classicAddress, MPTokenIssuanceID: '0'.repeat(48) } });
    const restarted = new FileStore(path);
    assert.equal(await restarted.isBanned('issuance', wallet.classicAddress), true);
    await assert.rejects(restarted.assertReady(wallet.classicAddress), /Unreconciled/);
    await restarted.settled({ hash: 'hash', ledgerIndex: 9, code: 'tesSUCCESS' });
    await restarted.assertReady(wallet.classicAddress);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
