import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { InMemoryBanStore, InvalidArgumentError, JsonFileBanStore, MPT_MAX_AMOUNT, parsePositiveAmount, SerialQueue } from '../src/index.js'

test('parsePositiveAmount accepts integers within MPT range', () => {
  assert.equal(parsePositiveAmount('500'), 500n)
  assert.equal(parsePositiveAmount(1n), 1n)
  assert.equal(parsePositiveAmount(MPT_MAX_AMOUNT.toString()), MPT_MAX_AMOUNT)
})

test('parsePositiveAmount rejects zero, negatives, decimals, hex and overflow', () => {
  for (const bad of ['0', 0n, -1n, '-1', '1.5', '1e3', '0x10', '', ' 1', (MPT_MAX_AMOUNT + 1n).toString()]) {
    assert.throws(() => parsePositiveAmount(bad), InvalidArgumentError, `accepted ${String(bad)}`)
  }
  assert.throws(() => parsePositiveAmount(5 as unknown as string), InvalidArgumentError)
})

const record = { issuanceId: 'X', holder: 'rA', reason: 'first', bannedAt: '2026-01-01T00:00:00.000Z' }

test('InMemoryBanStore keeps the original record on re-ban and scopes by issuance', async () => {
  const store = new InMemoryBanStore()
  await store.add(record)
  await store.add({ ...record, reason: 'second' })
  assert.equal((await store.get('X', 'rA'))?.reason, 'first')
  assert.equal(await store.get('Y', 'rA'), undefined)
  assert.equal((await store.list('X')).length, 1)
})

test('JsonFileBanStore persists across instances and serializes concurrent writes', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'bans-')), 'nested', 'bans.json')
  const store = new JsonFileBanStore(path)
  assert.equal(await store.get('X', 'rA'), undefined)
  await Promise.all(['rA', 'rB', 'rC', 'rA'].map((holder) => store.add({ ...record, holder })))
  const reopened = new JsonFileBanStore(path)
  assert.deepEqual((await reopened.list('X')).map((r) => r.holder).sort(), ['rA', 'rB', 'rC'])
  assert.equal(JSON.parse(await readFile(path, 'utf8')).length, 3)
})

test('JsonFileBanStore fails closed on a corrupt file', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'bans-')), 'bans.json')
  await writeFile(path, '{not json')
  await assert.rejects(new JsonFileBanStore(path).get('X', 'rA'))
})

test('SerialQueue runs tasks one at a time, in order, and survives failures', async () => {
  const queue = new SerialQueue()
  const events: string[] = []
  const task = (name: string, ms: number, fail = false) => () =>
    new Promise<string>((resolve, reject) => {
      events.push(`start ${name}`)
      setTimeout(() => {
        events.push(`end ${name}`)
        fail ? reject(new Error(name)) : resolve(name)
      }, ms)
    })
  const results = await Promise.allSettled([queue.run(task('a', 20)), queue.run(task('b', 1, true)), queue.run(task('c', 1))])
  assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled'])
})
