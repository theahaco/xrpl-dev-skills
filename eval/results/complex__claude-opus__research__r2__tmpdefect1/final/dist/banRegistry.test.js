import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonFileBanRegistry } from './banRegistry.js';
const record = (address) => ({ address, reason: 'test', bannedAt: '2026-01-01T00:00:00.000Z' });
test('JsonFileBanRegistry persists bans across instances and keeps the first record', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'bans-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'nested', 'bans.json');
    const registry = new JsonFileBanRegistry(path);
    assert.equal(await registry.isBanned('rA'), false);
    await Promise.all([registry.add(record('rA')), registry.add(record('rB')), registry.add({ ...record('rA'), reason: 'dup' })]);
    const reloaded = new JsonFileBanRegistry(path);
    assert.equal(await reloaded.isBanned('rA'), true);
    assert.equal(await reloaded.isBanned('rB'), true);
    assert.equal((await reloaded.get('rA'))?.reason, 'test');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).length, 2);
});
//# sourceMappingURL=banRegistry.test.js.map