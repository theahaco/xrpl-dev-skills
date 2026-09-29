import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBanStore, readJson, writeJson } from '../src/storage.js';
import { amount } from '../src/issuer.js';
import { isRpcError } from '../src/ledger.js';
test('ban storage persists across instances and scopes bans to issuance and holder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mpt-policy-'));
    try {
        const path = join(dir, 'bans.json');
        await new FileBanStore(path).add('id1', 'holder1');
        const restored = new FileBanStore(path);
        assert.equal(await restored.has('id1', 'holder1'), true);
        assert.equal(await restored.has('id2', 'holder1'), false);
        assert.equal(await restored.has('id1', 'holder2'), false);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        await restored.add('id1', 'holder1');
        assert.deepEqual(readJson(path), ['id1:holder1']);
        writeFileSync(path, '{broken');
        await assert.rejects(restored.has('id1', 'holder1'));
        writeJson(path, { unexpected: true });
        await assert.rejects(restored.has('id1', 'holder1'), /Corrupt/);
    }
    finally {
        rmSync(dir, { recursive: true });
    }
});
test('runtime callers cannot pass JavaScript numbers as amounts', () => {
    assert.throws(() => amount(1));
    assert.throws(() => amount(null));
});
test('only the exact expected RPC error is treated as missing state', () => {
    assert.equal(isRpcError({ data: { error: 'entryNotFound' } }, 'entryNotFound'), true);
    for (const value of [undefined, null, new Error('entryNotFound'), { data: { error: 'noPermission' } }]) {
        assert.equal(isRpcError(value, 'entryNotFound'), false);
    }
});
