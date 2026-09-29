import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { JsonFileBanRegistry } from '../src/banRegistry.js'

const ID = '0000000100112233445566778899AABBCCDDEEFF00112233'
const record = (address: string) => ({ issuanceId: ID, address, reason: 'test', bannedAt: '2026-01-01T00:00:00Z' })

test('bans persist across instances and are scoped per issuance', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'bans-')), 'nested', 'bans.json')
  const first = new JsonFileBanRegistry(path)
  await Promise.all([first.ban(record('rA')), first.ban(record('rB')), first.ban(record('rA'))])
  const second = new JsonFileBanRegistry(path)
  assert.equal(await second.isBanned(ID.toLowerCase(), 'rA'), true)
  assert.equal(await second.isBanned(ID, 'rC'), false)
  assert.equal(await second.isBanned('F'.repeat(48), 'rA'), false)
  assert.equal((await second.list(ID)).length, 2)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).length, 2)
})

test('an unreadable registry fails closed', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'bans-')), 'bans.json')
  await writeFile(path, '{not json')
  await assert.rejects(new JsonFileBanRegistry(path).isBanned(ID, 'rA'))
})
