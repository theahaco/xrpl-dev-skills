import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ComplianceViolationError, fromBaseUnits, MAX_MPT_AMOUNT, parseLedgerAmount, toBaseUnits } from '../src/index.js'

describe('toBaseUnits', () => {
  it('converts whole and fractional amounts', () => {
    assert.equal(toBaseUnits('500', 0), 500n)
    assert.equal(toBaseUnits('12.5', 2), 1250n)
    assert.equal(toBaseUnits('12.50', 2), 1250n)
    assert.equal(toBaseUnits('0.000001', 6), 1n)
  })

  it('rejects too many decimal places, zero, negatives and non-numbers', () => {
    for (const [amount, scale] of [['1.5', 0], ['0.001', 2], ['0', 2], ['-1', 0], ['1e3', 0], ['', 0], [' 1', 0]] as const) {
      assert.throws(() => toBaseUnits(amount, scale), ComplianceViolationError, `${amount} @ ${scale}`)
    }
  })

  it('enforces the ledger maximum', () => {
    assert.equal(toBaseUnits(MAX_MPT_AMOUNT.toString(), 0), MAX_MPT_AMOUNT)
    assert.throws(() => toBaseUnits((MAX_MPT_AMOUNT + 1n).toString(), 0), ComplianceViolationError)
  })

  it('rejects invalid scales', () => {
    assert.throws(() => toBaseUnits('1', -1), RangeError)
    assert.throws(() => toBaseUnits('1', 1.5), RangeError)
  })
})

describe('fromBaseUnits', () => {
  it('formats amounts without trailing zeros', () => {
    assert.equal(fromBaseUnits(700n, 0), '700')
    assert.equal(fromBaseUnits(1250n, 2), '12.5')
    assert.equal(fromBaseUnits(1n, 6), '0.000001')
    assert.equal(fromBaseUnits(0n, 2), '0')
  })

  it('round-trips with toBaseUnits', () => {
    for (const amount of ['1', '0.01', '123456.789']) assert.equal(fromBaseUnits(toBaseUnits(amount, 3), 3), amount)
  })
})

describe('parseLedgerAmount', () => {
  it('treats a missing MPTAmount as zero', () => {
    assert.equal(parseLedgerAmount(undefined), 0n)
    assert.equal(parseLedgerAmount('700'), 700n)
    assert.throws(() => parseLedgerAmount('1.5'), RangeError)
  })
})
