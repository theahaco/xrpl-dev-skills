import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MptIssuerError } from '../src/errors.js'
import { MAX_MPT_AMOUNT, formatBaseUnits, parseBaseUnits, toBaseUnits } from '../src/amounts.js'

test('parseBaseUnits accepts integers in range', () => {
  assert.equal(parseBaseUnits('500'), 500n)
  assert.equal(parseBaseUnits(7n), 7n)
  assert.equal(parseBaseUnits(MAX_MPT_AMOUNT.toString()), MAX_MPT_AMOUNT)
  assert.equal(parseBaseUnits('0', { allowZero: true }), 0n)
})

test('parseBaseUnits rejects zero, negatives, decimals, overflow and numbers', () => {
  for (const bad of ['0', '-1', '1.5', '01', '', ' 1', '1e3', (MAX_MPT_AMOUNT + 1n).toString()]) {
    assert.throws(() => parseBaseUnits(bad), MptIssuerError, bad)
  }
  assert.throws(() => parseBaseUnits(-1n))
  assert.throws(() => parseBaseUnits(5 as unknown as string))
})

test('toBaseUnits converts without rounding', () => {
  assert.equal(toBaseUnits('12.34', 2), 1234n)
  assert.equal(toBaseUnits('12.30', 2), 1230n)
  assert.equal(toBaseUnits('12', 2), 1200n)
  assert.equal(toBaseUnits('500', 0), 500n)
  assert.throws(() => toBaseUnits('0.001', 2))
  assert.throws(() => toBaseUnits('1.', 2))
})

test('formatBaseUnits round-trips', () => {
  assert.equal(formatBaseUnits(1234n, 2), '12.34')
  assert.equal(formatBaseUnits(5n, 2), '0.05')
  assert.equal(formatBaseUnits(1200n, 2), '12')
  assert.equal(formatBaseUnits(700n, 0), '700')
})
