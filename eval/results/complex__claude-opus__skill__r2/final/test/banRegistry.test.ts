import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { FileBanRegistry } from '../src'

test('FileBanRegistry persists bans, keeps the first record, survives reload', async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'bans-')), 'nested', 'bans.json')
  const registry = new FileBanRegistry(file)
  assert.equal(await registry.get('rA'), undefined)
  await Promise.all([
    registry.add({ address: 'rA', reason: 'first', bannedAt: '2026-01-01T00:00:00.000Z' }),
    registry.add({ address: 'rA', reason: 'second', bannedAt: '2026-01-02T00:00:00.000Z' }),
    registry.add({ address: 'rB', reason: 'other', bannedAt: '2026-01-03T00:00:00.000Z' }),
  ])
  const reloaded = new FileBanRegistry(file)
  assert.equal((await reloaded.get('rA'))?.reason, 'first')
  assert.equal((await reloaded.list()).length, 2)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 2)
})
