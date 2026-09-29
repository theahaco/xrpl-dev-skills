import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AmountError, MAX_MPT_AMOUNT, fromBaseUnits, parseLedgerAmount, toBaseUnits } from '../src/amounts.js'

describe('toBaseUnits', () => {
  it('scales display amounts', () => {
    assert.equal(toBaseUnits('500', 0), 500n)
    assert.equal(toBaseUnits('12.5', 2), 1250n)
    assert.equal(toBaseUnits('0.000001', 6), 1n)
    assert.equal(toBaseUnits('7.10', 1), 71n)
  })

  it('accepts the 63-bit maximum and rejects anything above it', () => {
    assert.equal(toBaseUnits(MAX_MPT_AMOUNT.toString(), 0), MAX_MPT_AMOUNT)
    assert.throws(() => toBaseUnits((MAX_MPT_AMOUNT + 1n).toString(), 0), AmountError)
  })

  it('rejects zero, negatives, excess precision and non-decimal input', () => {
    for (const bad of ['0', '0.00', '-1', '1.005', '1e3', ' 1', '1,000', '', '.5', '0x10', 'NaN']) {
      assert.throws(() => toBaseUnits(bad, 2), AmountError, bad)
    }
  })

  it('rejects an invalid asset scale', () => {
    assert.throws(() => toBaseUnits('1', -1), AmountError)
    assert.throws(() => toBaseUnits('1', 1.5), AmountError)
    assert.throws(() => toBaseUnits('1', 256), AmountError)
  })
})

describe('fromBaseUnits', () => {
  it('formats with the asset scale and trims trailing zeros', () => {
    assert.equal(fromBaseUnits(700n, 0), '700')
    assert.equal(fromBaseUnits(1250n, 2), '12.5')
    assert.equal(fromBaseUnits(1200n, 2), '12')
    assert.equal(fromBaseUnits(1n, 6), '0.000001')
    assert.equal(fromBaseUnits('0', 2), '0')
  })

  it('round-trips', () => {
    for (const [amount, scale] of [['1', 0], ['0.01', 2], ['123456.789', 3], ['92233720368547.75807', 5]] as const) {
      assert.equal(fromBaseUnits(toBaseUnits(amount, scale), scale), amount)
    }
  })
})

describe('parseLedgerAmount', () => {
  it('treats an absent field as zero and rejects malformed values', () => {
    assert.equal(parseLedgerAmount(undefined), 0n)
    assert.equal(parseLedgerAmount('9223372036854775807'), MAX_MPT_AMOUNT)
    assert.throws(() => parseLedgerAmount('-5'), AmountError)
    assert.throws(() => parseLedgerAmount('1.5'), AmountError)
  })
})
