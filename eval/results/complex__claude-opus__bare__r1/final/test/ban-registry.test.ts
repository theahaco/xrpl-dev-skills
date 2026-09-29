import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { JsonFileBanRegistry } from '../src/index.js'

const record = (address: string, reason = 'r') => ({ address, reason, bannedAt: '2026-01-01T00:00:00.000Z' })

test('JsonFileBanRegistry persists bans and keeps the first record', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'bans-')), 'nested', 'bans.json')
  const registry = new JsonFileBanRegistry(path)
  assert.equal(await registry.get('rA'), undefined)
  await registry.add(record('rA', 'first'))
  const second = await registry.add(record('rA', 'second'))
  assert.equal(second.reason, 'first')
  assert.equal((await new JsonFileBanRegistry(path).get('rA'))?.reason, 'first')
  assert.ok(JSON.parse(await readFile(path, 'utf8')).rA)
})

test('JsonFileBanRegistry serializes concurrent adds', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'bans-')), 'bans.json')
  const registry = new JsonFileBanRegistry(path)
  await Promise.all(Array.from({ length: 20 }, (_, i) => registry.add(record(`r${i}`))))
  assert.equal((await registry.list()).length, 20)
})

test('JsonFileBanRegistry refuses to treat a corrupt file as empty', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'bans-')), 'bans.json')
  await writeFile(path, '{not json')
  await assert.rejects(new JsonFileBanRegistry(path).get('rA'))
  await writeFile(path, '[]')
  await assert.rejects(new JsonFileBanRegistry(path).get('rA'))
})
