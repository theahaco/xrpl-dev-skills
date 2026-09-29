import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { InMemoryBanList, JsonFileBanList } from '../src/banList.js'

const record = (address: string, reason = 'sanctions hit') => ({
  address,
  reason,
  bannedAt: '2026-09-29T00:00:00.000Z',
})

describe('InMemoryBanList', () => {
  it('records bans idempotently, keeping the first record', async () => {
    const list = new InMemoryBanList()
    await list.add(record('rA'))
    await list.add(record('rA', 'second reason'))
    assert.equal(await list.isBanned('rA'), true)
    assert.equal(await list.isBanned('rB'), false)
    assert.equal((await list.get('rA'))?.reason, 'sanctions hit')
    assert.equal((await list.list()).length, 1)
  })
})

describe('JsonFileBanList', () => {
  it('persists across instances and handles concurrent writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'banlist-'))
    try {
      const path = join(dir, 'nested', 'bans.json')
      const list = new JsonFileBanList(path)
      assert.equal(await list.isBanned('rA'), false)
      await Promise.all([list.add(record('rA')), list.add(record('rB')), list.add(record('rC'))])
      const reloaded = new JsonFileBanList(path)
      assert.deepEqual((await reloaded.list()).map((r) => r.address).sort(), ['rA', 'rB', 'rC'])
      assert.equal(JSON.parse(await readFile(path, 'utf8')).length, 3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on a corrupt file instead of treating it as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'banlist-'))
    try {
      const path = join(dir, 'bans.json')
      await writeFile(path, '{not json')
      await assert.rejects(new JsonFileBanList(path).isBanned('rA'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
