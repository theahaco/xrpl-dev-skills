import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { TransactionMetadata } from 'xrpl';

import {
  InMemoryComplianceRegistry,
  JsonFileComplianceRegistry,
  MAX_MPT_AMOUNT,
  ValidationError,
  clawedBackAmount,
  normalizeIssuanceId,
  parseAmount,
} from '../src/index.js';

const ID = '0142A0880F2CB7F5E3536A4837F5FBE6D4467E320DD13C82';
const HOLDER = 'r4ueyaAErQVWYX9Kdn5xgjbF99ECfWhFAh';

describe('parseAmount', () => {
  it('accepts positive bigints and digit strings', () => {
    assert.equal(parseAmount(500n), 500n);
    assert.equal(parseAmount('1000'), 1000n);
    assert.equal(parseAmount(MAX_MPT_AMOUNT.toString()), MAX_MPT_AMOUNT);
  });

  it('rejects zero, negatives, decimals, overflow and numbers', () => {
    for (const bad of [0n, -1n, '0', '-5', '1.5', '1e3', ' 10', '', (MAX_MPT_AMOUNT + 1n).toString()]) {
      assert.throws(() => parseAmount(bad), ValidationError, String(bad));
    }
    assert.throws(() => parseAmount(10 as unknown as string), ValidationError);
  });
});

describe('normalizeIssuanceId', () => {
  it('uppercases valid IDs and rejects malformed ones', () => {
    assert.equal(normalizeIssuanceId(ID.toLowerCase()), ID);
    assert.throws(() => normalizeIssuanceId(ID.slice(1)), ValidationError);
    assert.throws(() => normalizeIssuanceId(`${ID.slice(1)}Z`), ValidationError);
  });
});

describe('clawedBackAmount', () => {
  const meta = (previous: string | undefined, final: string | undefined, account = HOLDER) =>
    ({
      TransactionResult: 'tesSUCCESS',
      TransactionIndex: 0,
      AffectedNodes: [
        { ModifiedNode: { LedgerEntryType: 'MPTokenIssuance', LedgerIndex: 'X', FinalFields: { OutstandingAmount: '0' } } },
        {
          ModifiedNode: {
            LedgerEntryType: 'MPToken',
            LedgerIndex: 'Y',
            FinalFields: { Account: account, MPTokenIssuanceID: ID, Flags: 1, ...(final === undefined ? {} : { MPTAmount: final }) },
            PreviousFields: previous === undefined ? {} : { MPTAmount: previous },
          },
        },
      ],
    }) as unknown as TransactionMetadata;

  it('computes partial clawback', () => assert.equal(clawedBackAmount(meta('1000', '700'), ID, HOLDER), 300n));
  it('treats an omitted final amount as zero', () => assert.equal(clawedBackAmount(meta('249', undefined), ID, HOLDER), 249n));
  it('ignores other holders', () => assert.equal(clawedBackAmount(meta('10', '0', 'rDt1xVymF4qRTESGXfRb6TAnVzcbV3jZku'), ID, HOLDER), 0n));
  it('returns zero when the amount did not change', () => assert.equal(clawedBackAmount(meta(undefined, '5'), ID, HOLDER), 0n));
});

describe('compliance registries', () => {
  const record = { issuanceId: ID, address: HOLDER, reason: 'test', bannedAt: '2026-01-01T00:00:00.000Z' };

  it('in-memory: scopes bans per issuance and dedupes', async () => {
    const r = new InMemoryComplianceRegistry();
    await r.recordBan(record);
    await r.recordBan(record);
    assert.equal(await r.isBanned(ID, HOLDER), true);
    assert.equal(await r.isBanned(ID.replace(/^0/, '1'), HOLDER), false);
    assert.equal((await r.listBans(ID)).length, 1);
  });

  it('json file: persists bans across reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mpt-registry-'));
    try {
      const path = join(dir, 'nested', 'registry.json');
      const r1 = await JsonFileComplianceRegistry.open(path);
      assert.equal(await r1.isBanned(ID, HOLDER), false);
      await r1.recordBan(record);
      const r2 = await JsonFileComplianceRegistry.open(path);
      assert.equal(await r2.isBanned(ID, HOLDER), true);
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).bans, [record]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('json file: refuses to open a corrupt file rather than starting empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mpt-registry-'));
    try {
      const path = join(dir, 'registry.json');
      await (await import('node:fs/promises')).writeFile(path, '{"nope":1}');
      await assert.rejects(JsonFileComplianceRegistry.open(path));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
