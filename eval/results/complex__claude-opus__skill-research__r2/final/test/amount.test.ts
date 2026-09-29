import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fromBaseUnits, MAX_MPT_AMOUNT, toBaseUnits, toPositiveBaseUnits } from '../src/amount.js'

describe('toBaseUnits', () => {
  it('converts whole and fractional amounts', () => {
    assert.equal(toBaseUnits('500', 0), 500n)
    assert.equal(toBaseUnits('12.34', 2), 1234n)
    assert.equal(toBaseUnits('12.3', 2), 1230n)
    assert.equal(toBaseUnits('0.000001', 6), 1n)
    assert.equal(toBaseUnits('7.50', 1), 75n)
  })

  it('never rounds: rejects more decimals than the scale', () => {
    assert.throws(() => toBaseUnits('1.001', 2), RangeError)
    assert.throws(() => toBaseUnits('0.5', 0), RangeError)
  })

  it('rejects malformed, negative and exponent input', () => {
    for (const bad of ['', '-1', '1e3', '01', '1.', '.5', ' 1', 'abc', '1,000']) {
      assert.throws(() => toBaseUnits(bad, 2), RangeError, bad)
    }
  })

  it('enforces the 2^63-1 ledger maximum', () => {
    assert.equal(toBaseUnits(MAX_MPT_AMOUNT.toString(), 0), MAX_MPT_AMOUNT)
    assert.throws(() => toBaseUnits((MAX_MPT_AMOUNT + 1n).toString(), 0), RangeError)
  })

  it('rejects invalid scales', () => {
    assert.throws(() => toBaseUnits('1', -1), RangeError)
    assert.throws(() => toBaseUnits('1', 1.5), RangeError)
  })
})

describe('toPositiveBaseUnits', () => {
  it('rejects zero', () => {
    assert.throws(() => toPositiveBaseUnits('0', 2), RangeError)
    assert.throws(() => toPositiveBaseUnits('0.00', 2), RangeError)
    assert.equal(toPositiveBaseUnits('0.01', 2), 1n)
  })
})

describe('fromBaseUnits', () => {
  it('formats base units', () => {
    assert.equal(fromBaseUnits(500n, 0), '500')
    assert.equal(fromBaseUnits('1234', 2), '12.34')
    assert.equal(fromBaseUnits(1230n, 2), '12.3')
    assert.equal(fromBaseUnits(1200n, 2), '12')
    assert.equal(fromBaseUnits(1n, 6), '0.000001')
    assert.equal(fromBaseUnits(0n, 4), '0')
  })

  it('round-trips', () => {
    for (const [value, scale] of [['0.07', 2], ['123456.789', 3], ['9', 0]] as const) {
      assert.equal(fromBaseUnits(toBaseUnits(value, scale), scale), value)
    }
  })
})
