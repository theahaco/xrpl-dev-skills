import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { FileBanRegistry } from '../src/issuer/banRegistry.js'

// Created under the project so the tests also run in sandboxes that forbid the system temp dir.
const dir = await mkdtemp(join(import.meta.dirname, '.tmp-ban-'))
after(() => rm(dir, { recursive: true, force: true }))

const ID = '0000000100000000000000000000000000000000000000AA'
const ADDR = 'rLfjZKWdBPJYwgBrkjo6Ukhn1ZW2ePj8dZ'

test('a missing file means nobody is banned', async () => {
  const reg = new FileBanRegistry(join(dir, 'missing', 'bans.json'))
  assert.equal(await reg.isBanned(ID, ADDR), false)
})

test('bans persist across instances and are scoped to the issuance', async () => {
  const path = join(dir, 'persist.json')
  await new FileBanRegistry(path).recordBan({ issuanceId: ID, address: ADDR, reason: 'test', bannedAt: '2026-01-01T00:00:00.000Z' })
  const reopened = new FileBanRegistry(path)
  assert.equal(await reopened.isBanned(ID, ADDR), true)
  assert.equal((await reopened.getBan(ID, ADDR))?.reason, 'test')
  assert.equal(await reopened.isBanned(ID.replace(/AA$/, 'BB'), ADDR), false)
})

test('recording the same ban twice keeps a single record', async () => {
  const path = join(dir, 'dupe.json')
  const reg = new FileBanRegistry(path)
  const record = { issuanceId: ID, address: ADDR, reason: 'first', bannedAt: '2026-01-01T00:00:00.000Z' }
  await Promise.all([reg.recordBan(record), reg.recordBan({ ...record, reason: 'second' })])
  const file = JSON.parse(await readFile(path, 'utf8')) as { bans: unknown[] }
  assert.equal(file.bans.length, 1)
})

test('a corrupt registry fails closed instead of reporting "not banned"', async () => {
  const path = join(dir, 'corrupt.json')
  await writeFile(path, '{"version": 2}')
  await assert.rejects(new FileBanRegistry(path).isBanned(ID, ADDR))
})
