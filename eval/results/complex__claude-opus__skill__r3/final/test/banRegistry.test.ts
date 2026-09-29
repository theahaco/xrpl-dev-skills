import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileBanRegistry, InMemoryBanRegistry } from '../src/index.js';

const ID = '0'.repeat(48);
const rec = (address: string, issuanceId = ID) => ({ address, issuanceId, reason: 'r', bannedAt: '2026-01-01T00:00:00.000Z' });

for (const [name, make] of [
  ['InMemoryBanRegistry', async () => ({ reg: new InMemoryBanRegistry(), cleanup: async () => {} })],
  [
    'FileBanRegistry',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bans-'));
      return { reg: new FileBanRegistry(join(dir, 'sub', 'bans.json')), cleanup: () => rm(dir, { recursive: true }) };
    },
  ],
] as const) {
  test(`${name}: add/get/list, idempotent, scoped per issuance, concurrent-safe`, async () => {
    const { reg, cleanup } = await make();
    try {
      assert.equal(await reg.get(ID, 'rA'), undefined);
      await Promise.all([reg.add(rec('rA')), reg.add(rec('rB')), reg.add(rec('rA')), reg.add(rec('rA', 'F'.repeat(48)))]);
      assert.equal((await reg.get(ID, 'rA'))?.address, 'rA');
      assert.deepEqual((await reg.list(ID)).map((r) => r.address).sort(), ['rA', 'rB']);
      assert.equal((await reg.list('F'.repeat(48))).length, 1);
    } finally {
      await cleanup();
    }
  });
}

test('FileBanRegistry persists across instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bans-'));
  try {
    const path = join(dir, 'bans.json');
    await new FileBanRegistry(path).add(rec('rA'));
    assert.equal((await new FileBanRegistry(path).get(ID, 'rA'))?.reason, 'r');
    assert.ok(Array.isArray(JSON.parse(await readFile(path, 'utf8'))));
  } finally {
    await rm(dir, { recursive: true });
  }
});
