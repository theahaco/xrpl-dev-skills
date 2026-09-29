import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { fromRawAmount, MAX_MPT_RAW, toRawAmount } from '../src/amount.js'
import { InvalidInputError } from '../src/errors.js'

test('toRawAmount scales exactly', () => {
  assert.equal(toRawAmount('500', 0), 500n)
  assert.equal(toRawAmount('12.5', 2), 1250n)
  assert.equal(toRawAmount('0.01', 2), 1n)
  assert.equal(toRawAmount('9223372036854775807', 0), MAX_MPT_RAW)
})

test('toRawAmount rejects invalid, zero, over-precise and overflowing amounts', () => {
  for (const [value, scale] of [
    ['0', 0], ['0.00', 2], ['-1', 0], ['1e3', 0], ['01', 0], ['1.', 2], [' 1', 0],
    ['1.5', 0], ['0.001', 2], ['9223372036854775808', 0],
  ] as const) {
    assert.throws(() => toRawAmount(value, scale), InvalidInputError, `${value} @ ${scale}`)
  }
  assert.throws(() => toRawAmount(5 as unknown as string, 0), InvalidInputError)
  assert.throws(() => toRawAmount('1', -1), InvalidInputError)
})

test('fromRawAmount formats without trailing zeros', () => {
  assert.equal(fromRawAmount(0n, 2), '0')
  assert.equal(fromRawAmount(1n, 2), '0.01')
  assert.equal(fromRawAmount(1250n, 2), '12.5')
  assert.equal(fromRawAmount('70000', 2), '700')
  assert.equal(fromRawAmount('700', 0), '700')
})
