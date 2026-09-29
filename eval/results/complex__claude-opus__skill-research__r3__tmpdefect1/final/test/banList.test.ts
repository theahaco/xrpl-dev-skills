import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { type BanRecord, FileBanList, InMemoryBanList } from '../src/index.js'

const record = (address: string): BanRecord => ({
  address,
  issuanceId: 'ID',
  reason: 'test',
  bannedAt: '2026-01-01T00:00:00.000Z',
  txHashes: [],
})

describe('FileBanList', async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'banlist-'))
  after(() => rm(dir, { recursive: true, force: true }))

  it('returns nothing when the file does not exist yet', async () => {
    const list = new FileBanList(join(dir, 'missing', 'bans.json'))
    assert.equal(await list.get('rX'), undefined)
    assert.deepEqual(await list.list(), [])
  })

  it('persists records across instances', async () => {
    const path = join(dir, 'nested', 'bans.json')
    await new FileBanList(path).put(record('rA'))
    const reopened = new FileBanList(path)
    assert.deepEqual(await reopened.get('rA'), record('rA'))
    assert.equal(await reopened.get('rB'), undefined)
    assert.ok(JSON.parse(await readFile(path, 'utf8')).rA)
  })

  it('does not lose concurrent writes', async () => {
    const list = new FileBanList(join(dir, 'concurrent.json'))
    await Promise.all(Array.from({ length: 20 }, (_, i) => list.put(record(`r${i}`))))
    assert.equal((await list.list()).length, 20)
  })

  it('updates an existing record', async () => {
    const list = new FileBanList(join(dir, 'update.json'))
    await list.put(record('rA'))
    await list.put({ ...record('rA'), txHashes: ['H1'] })
    assert.deepEqual((await list.get('rA'))?.txHashes, ['H1'])
  })
})

describe('InMemoryBanList', () => {
  it('returns copies so callers cannot mutate stored records', async () => {
    const list = new InMemoryBanList()
    await list.put(record('rA'))
    const fetched = await list.get('rA')
    fetched?.txHashes.push('X')
    assert.deepEqual((await list.get('rA'))?.txHashes, [])
  })
})
