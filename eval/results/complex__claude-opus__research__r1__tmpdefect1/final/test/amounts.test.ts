import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_MPT_BASE_UNITS, fromBaseUnits, parseLedgerAmount, toBaseUnits } from '../src/issuer/amounts.js'
import { InvalidInputError } from '../src/issuer/errors.js'

test('toBaseUnits scales whole and fractional amounts exactly', () => {
  assert.equal(toBaseUnits('500', 2), 50_000n)
  assert.equal(toBaseUnits('12.5', 2), 1_250n)
  assert.equal(toBaseUnits('12.50', 2), 1_250n)
  assert.equal(toBaseUnits('0.01', 2), 1n)
  assert.equal(toBaseUnits('7', 0), 7n)
  assert.equal(toBaseUnits('1.000', 0), 1n)
})

test('toBaseUnits rejects amounts that cannot be represented exactly', () => {
  for (const bad of ['0', '0.00', '-1', '1e3', '', ' 1', '1.', '.5', '0.001', 'abc', '1,000']) {
    assert.throws(() => toBaseUnits(bad, 2), InvalidInputError, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('toBaseUnits enforces the 63-bit ceiling', () => {
  assert.equal(toBaseUnits(MAX_MPT_BASE_UNITS.toString(), 0), MAX_MPT_BASE_UNITS)
  assert.throws(() => toBaseUnits((MAX_MPT_BASE_UNITS + 1n).toString(), 0), InvalidInputError)
  assert.throws(() => toBaseUnits('92233720368547758.08', 2), InvalidInputError)
})

test('toBaseUnits validates the asset scale', () => {
  assert.throws(() => toBaseUnits('1', -1), InvalidInputError)
  assert.throws(() => toBaseUnits('1', 1.5), InvalidInputError)
  assert.throws(() => toBaseUnits('1', 20), InvalidInputError)
})

test('fromBaseUnits formats without trailing zeros and round-trips', () => {
  assert.equal(fromBaseUnits(50_000n, 2), '500')
  assert.equal(fromBaseUnits(1_250n, 2), '12.5')
  assert.equal(fromBaseUnits(1n, 2), '0.01')
  assert.equal(fromBaseUnits(0n, 2), '0')
  assert.equal(fromBaseUnits(42n, 0), '42')
  for (const s of ['1', '0.01', '123456.78', '92233720368547758.07']) {
    assert.equal(fromBaseUnits(toBaseUnits(s, 2), 2), s)
  }
})

test('parseLedgerAmount treats an absent field as zero and rejects garbage', () => {
  assert.equal(parseLedgerAmount(undefined), 0n)
  assert.equal(parseLedgerAmount('70000'), 70_000n)
  assert.throws(() => parseLedgerAmount('1.5'))
  assert.throws(() => parseLedgerAmount('-1'))
})
