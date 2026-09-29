import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_MPT_AMOUNT, ValidationError, fromBaseUnits, toBaseUnits } from '../src/index.js'

test('toBaseUnits scales decimal strings exactly', () => {
  assert.equal(toBaseUnits('500', 2), 50000n)
  assert.equal(toBaseUnits('12.5', 2), 1250n)
  assert.equal(toBaseUnits('0.01', 2), 1n)
  assert.equal(toBaseUnits('1.10', 1), 11n) // trailing zeros beyond the scale are fine
  assert.equal(toBaseUnits('7', 0), 7n)
})

test('toBaseUnits rejects invalid amounts', () => {
  for (const bad of ['', '-1', '0', '0.00', '1.001', '1e3', ' 1', '01', 'abc', '1.']) {
    assert.throws(() => toBaseUnits(bad, 2), ValidationError, bad)
  }
  assert.throws(() => toBaseUnits((MAX_MPT_AMOUNT + 1n).toString(), 0), ValidationError)
  assert.equal(toBaseUnits(MAX_MPT_AMOUNT.toString(), 0), MAX_MPT_AMOUNT)
})

test('fromBaseUnits formats without floating point', () => {
  assert.equal(fromBaseUnits(50000n, 2), '500')
  assert.equal(fromBaseUnits(1250n, 2), '12.5')
  assert.equal(fromBaseUnits(1n, 2), '0.01')
  assert.equal(fromBaseUnits(0n, 2), '0')
  assert.equal(fromBaseUnits(MAX_MPT_AMOUNT, 6), '9223372036854.775807')
})
