import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { Wallet } from 'xrpl'

import { FileBanRegistry, InMemoryBanRegistry } from '../src/banRegistry.js'

const addressA = Wallet.generate().classicAddress
const addressB = Wallet.generate().classicAddress
const dir = await mkdtemp(join(tmpdir(), 'ban-registry-'))
after(() => rm(dir, { recursive: true, force: true }))

describe('FileBanRegistry', () => {
  it('persists bans across instances and is idempotent', async () => {
    const path = join(dir, 'persist.json')
    const first = new FileBanRegistry(path)
    assert.equal(await first.isBanned(addressA), false)
    await first.add({ address: addressA, bannedAt: '2026-01-01T00:00:00.000Z', reason: 'first' })
    await first.add({ address: addressA, bannedAt: '2026-02-01T00:00:00.000Z', reason: 'second' })

    const second = new FileBanRegistry(path)
    assert.equal(await second.isBanned(addressA), true)
    assert.equal(await second.isBanned(addressB), false)
    const bans = await second.list()
    assert.equal(bans.length, 1)
    assert.equal(bans[0]?.reason, 'first')
  })

  it('serializes concurrent writes without losing any', async () => {
    const registry = new FileBanRegistry(join(dir, 'concurrent.json'))
    const addresses = Array.from({ length: 20 }, () => Wallet.generate().classicAddress)
    await Promise.all(addresses.map((address) => registry.add({ address, bannedAt: new Date().toISOString() })))
    assert.equal((await registry.list()).length, addresses.length)
  })

  it('fails closed on a corrupt file', async () => {
    const path = join(dir, 'corrupt.json')
    await writeFile(path, '{"version":1,"bans":"nope"}')
    await assert.rejects(new FileBanRegistry(path).isBanned(addressA), /malformed/)
  })

  it('rejects invalid addresses', async () => {
    const registry = new FileBanRegistry(join(dir, 'invalid.json'))
    await assert.rejects(registry.add({ address: 'not-an-address', bannedAt: '2026-01-01' }))
    await assert.rejects(readFile(join(dir, 'invalid.json')), /ENOENT/)
  })
})

describe('InMemoryBanRegistry', () => {
  it('records bans', async () => {
    const registry = new InMemoryBanRegistry()
    await registry.add({ address: addressB, bannedAt: '2026-01-01' })
    assert.equal(await registry.isBanned(addressB), true)
    assert.equal(await registry.isBanned(addressA), false)
  })
})
