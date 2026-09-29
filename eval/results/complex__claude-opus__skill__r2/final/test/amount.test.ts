import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fromBaseUnits, MAX_MPT_AMOUNT, parseAmount, toBaseUnits, ValidationError } from '../src'

test('parseAmount accepts positive integers up to 2^63-1', () => {
  assert.equal(parseAmount('500'), 500n)
  assert.equal(parseAmount(MAX_MPT_AMOUNT), MAX_MPT_AMOUNT)
})

test('parseAmount rejects zero, negatives, decimals, overflow and numbers', () => {
  for (const bad of ['0', '-1', '1.5', '', ' 1', (MAX_MPT_AMOUNT + 1n).toString()]) {
    assert.throws(() => parseAmount(bad), ValidationError, bad)
  }
  assert.throws(() => parseAmount(0n), ValidationError)
  assert.throws(() => parseAmount(5 as unknown as string), ValidationError)
})

test('toBaseUnits / fromBaseUnits round trip and reject excess precision', () => {
  assert.equal(toBaseUnits('12.34', 2), 1234n)
  assert.equal(toBaseUnits('12.30', 2), 1230n)
  assert.equal(toBaseUnits('7', 0), 7n)
  assert.throws(() => toBaseUnits('0.001', 2), ValidationError)
  assert.equal(fromBaseUnits(1234n, 2), '12.34')
  assert.equal(fromBaseUnits(5n, 2), '0.05')
  assert.equal(fromBaseUnits(1200n, 2), '12')
})
