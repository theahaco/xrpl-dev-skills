import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_MPT_AMOUNT, fromBaseUnits, toBaseUnits } from '../src/amounts.js';
import { ComplianceError } from '../src/errors.js';

describe('toBaseUnits', () => {
  it('converts whole and fractional amounts exactly', () => {
    assert.equal(toBaseUnits('500', 0), 500n);
    assert.equal(toBaseUnits('500', 2), 50_000n);
    assert.equal(toBaseUnits('0.01', 2), 1n);
    assert.equal(toBaseUnits('1.10', 1), 11n);
    assert.equal(toBaseUnits('123456789.123456', 6), 123_456_789_123_456n);
  });

  it('accepts the ledger maximum and rejects anything above it', () => {
    assert.equal(toBaseUnits(MAX_MPT_AMOUNT.toString(), 0), MAX_MPT_AMOUNT);
    assert.throws(() => toBaseUnits((MAX_MPT_AMOUNT + 1n).toString(), 0), ComplianceError);
  });

  for (const bad of ['0', '0.00', '-1', '1e3', '1.', '.5', ' 1', '', 'abc', '1,000', 'NaN']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => toBaseUnits(bad, 2), ComplianceError);
    });
  }

  it('rejects more decimals than the asset scale', () => {
    assert.throws(() => toBaseUnits('1.5', 0), ComplianceError);
    assert.throws(() => toBaseUnits('0.001', 2), ComplianceError);
  });

  it('rejects invalid asset scales', () => {
    assert.throws(() => toBaseUnits('1', -1), ComplianceError);
    assert.throws(() => toBaseUnits('1', 1.5), ComplianceError);
    assert.throws(() => toBaseUnits('1', 19), ComplianceError);
  });
});

describe('fromBaseUnits', () => {
  it('formats amounts and trims trailing zeros', () => {
    assert.equal(fromBaseUnits(0n, 0), '0');
    assert.equal(fromBaseUnits(0n, 2), '0');
    assert.equal(fromBaseUnits(700n, 0), '700');
    assert.equal(fromBaseUnits(70_000n, 2), '700');
    assert.equal(fromBaseUnits(1n, 2), '0.01');
    assert.equal(fromBaseUnits(12_345n, 3), '12.345');
  });

  it('round-trips', () => {
    for (const value of ['1', '0.5', '999.999', '1000000']) {
      assert.equal(fromBaseUnits(toBaseUnits(value, 3), 3), value);
    }
  });
});
