import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FileBanRegistry, InMemoryBanRegistry } from '../src/index.js'

const ban = { issuanceId: 'ID1', address: 'rAddr', reason: 'r', bannedAt: '2026-01-01T00:00:00.000Z' }

test('FileBanRegistry persists bans per issuance and is idempotent', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'bans-')), 'nested', 'bans.json')
  const registry = new FileBanRegistry(path)
  assert.equal(await registry.isBanned('ID1', 'rAddr'), false)
  await Promise.all([registry.record(ban), registry.record(ban), registry.record({ ...ban, issuanceId: 'ID2' })])
  assert.equal(await new FileBanRegistry(path).isBanned('ID1', 'rAddr'), true)
  assert.equal(await registry.isBanned('ID3', 'rAddr'), false)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).length, 2)
})

test('InMemoryBanRegistry keeps the first record', async () => {
  const registry = new InMemoryBanRegistry()
  await registry.record(ban)
  await registry.record({ ...ban, reason: 'other' })
  assert.equal((await registry.get('ID1', 'rAddr'))?.reason, 'r')
})
