import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_MPT_AMOUNT, fromRawAmount, toRawAmount } from '../src/amounts.js'

test('toRawAmount scales decimals', () => {
  assert.equal(toRawAmount('500', 0), 500n)
  assert.equal(toRawAmount('1.5', 2), 150n)
  assert.equal(toRawAmount('1.50', 1), 15n)
  assert.equal(toRawAmount('0.01', 2), 1n)
  assert.equal(toRawAmount('7.000', 0), 7n)
})

test('toRawAmount rejects invalid input', () => {
  for (const bad of ['', '-1', '0', '0.00', '1e3', ' 1', '1.', '.5', 'abc', '1,000']) {
    assert.throws(() => toRawAmount(bad, 2), RangeError, bad)
  }
  assert.throws(() => toRawAmount('1.234', 2), RangeError)
  assert.throws(() => toRawAmount((MAX_MPT_AMOUNT + 1n).toString(), 0), RangeError)
  assert.equal(toRawAmount(MAX_MPT_AMOUNT.toString(), 0), MAX_MPT_AMOUNT)
})

test('fromRawAmount formats', () => {
  assert.equal(fromRawAmount(0n, 0), '0')
  assert.equal(fromRawAmount(0n, 2), '0')
  assert.equal(fromRawAmount(700n, 0), '700')
  assert.equal(fromRawAmount(12345n, 2), '123.45')
  assert.equal(fromRawAmount(5n, 3), '0.005')
  assert.equal(fromRawAmount(1500n, 3), '1.5')
})
