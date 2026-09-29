import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_MPT_AMOUNT, fromBaseUnits, parseLedgerAmount, toBaseUnits } from './amount.js'
import { InvalidInputError } from './errors.js'

test('toBaseUnits scales decimal strings exactly', () => {
  assert.equal(toBaseUnits('500', 0), 500n)
  assert.equal(toBaseUnits('12.34', 2), 1234n)
  assert.equal(toBaseUnits('12.340', 2), 1234n)
  assert.equal(toBaseUnits('12.3', 2), 1230n)
  assert.equal(toBaseUnits('0.000001', 6), 1n)
  assert.equal(toBaseUnits('1.0', 0), 1n)
  assert.equal(toBaseUnits(MAX_MPT_AMOUNT.toString(), 0), MAX_MPT_AMOUNT)
})

test('toBaseUnits rejects ambiguous or out-of-range input', () => {
  for (const bad of ['', ' 1', '-1', '+1', '1e3', '1.', '.5', '0x10', '1,000', '1.234']) {
    assert.throws(() => toBaseUnits(bad, 2), InvalidInputError, JSON.stringify(bad))
  }
  assert.throws(() => toBaseUnits((MAX_MPT_AMOUNT + 1n).toString(), 0), InvalidInputError)
  assert.throws(() => toBaseUnits('1', -1), InvalidInputError)
  assert.throws(() => toBaseUnits('1', 1.5), InvalidInputError)
})

test('fromBaseUnits formats without trailing zeros', () => {
  assert.equal(fromBaseUnits(1234n, 2), '12.34')
  assert.equal(fromBaseUnits(1200n, 2), '12')
  assert.equal(fromBaseUnits(5n, 3), '0.005')
  assert.equal(fromBaseUnits(0n, 2), '0')
  assert.equal(fromBaseUnits(700n, 0), '700')
})

test('round-trips', () => {
  for (const [amount, scale] of [['0.01', 2], ['123456.789', 3], ['7', 6]] as const) {
    assert.equal(fromBaseUnits(toBaseUnits(amount, scale), scale), amount)
  }
})

test('parseLedgerAmount treats an absent field as zero', () => {
  assert.equal(parseLedgerAmount(undefined), 0n)
  assert.equal(parseLedgerAmount('700'), 700n)
  assert.throws(() => parseLedgerAmount(700))
  assert.throws(() => parseLedgerAmount('-1'))
})
