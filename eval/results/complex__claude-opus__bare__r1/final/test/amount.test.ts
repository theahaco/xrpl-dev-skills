import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { fromBaseUnits, InvalidInputError, toBaseUnits, toPositiveBaseUnits } from '../src/index.js'

test('toBaseUnits scales decimal strings exactly', () => {
  assert.equal(toBaseUnits('500', 0), 500n)
  assert.equal(toBaseUnits('12.34', 2), 1234n)
  assert.equal(toBaseUnits('12.3', 2), 1230n)
  assert.equal(toBaseUnits('12.30', 2), 1230n)
  assert.equal(toBaseUnits('0.000001', 6), 1n)
  assert.equal(toBaseUnits('9223372036854775807', 0), 9223372036854775807n)
})

test('toBaseUnits rejects malformed, negative, over-precise and out-of-range input', () => {
  for (const bad of ['', '-1', '1e3', '01', '1.', '.5', ' 1', '1,000', 'NaN', '0x10']) {
    assert.throws(() => toBaseUnits(bad, 2), InvalidInputError, bad)
  }
  assert.throws(() => toBaseUnits('1.234', 2), InvalidInputError)
  assert.throws(() => toBaseUnits('0.5', 0), InvalidInputError)
  assert.throws(() => toBaseUnits('9223372036854775808', 0), InvalidInputError)
  assert.throws(() => toBaseUnits(5 as unknown as string, 0), InvalidInputError)
})

test('toPositiveBaseUnits rejects zero', () => {
  assert.throws(() => toPositiveBaseUnits('0.00', 2), InvalidInputError)
})

test('fromBaseUnits round-trips', () => {
  assert.equal(fromBaseUnits(1234n, 2), '12.34')
  assert.equal(fromBaseUnits(1230n, 2), '12.3')
  assert.equal(fromBaseUnits(5n, 3), '0.005')
  assert.equal(fromBaseUnits(0n, 2), '0')
  assert.equal(fromBaseUnits(700n, 0), '700')
  for (const value of ['0.01', '1', '999999.99']) assert.equal(fromBaseUnits(toBaseUnits(value, 2), 2), value)
})
