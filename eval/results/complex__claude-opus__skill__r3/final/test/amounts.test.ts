import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidInputError, MAX_MPT_AMOUNT, fromBaseUnits, parseAmount, parsePositiveAmount, toBaseUnits } from '../src/index.js';

test('parseAmount accepts bigint and canonical integer strings', () => {
  assert.equal(parseAmount(500n), 500n);
  assert.equal(parseAmount('0'), 0n);
  assert.equal(parseAmount(MAX_MPT_AMOUNT.toString()), MAX_MPT_AMOUNT);
});

test('parseAmount rejects floats, negatives, leading zeros, overflow and numbers', () => {
  for (const bad of ['1.5', '-1', '01', '', ' 1', '1e3', (MAX_MPT_AMOUNT + 1n).toString()]) {
    assert.throws(() => parseAmount(bad), InvalidInputError, bad);
  }
  assert.throws(() => parseAmount(-1n), InvalidInputError);
  assert.throws(() => parseAmount(5 as unknown as string), InvalidInputError);
  assert.throws(() => parsePositiveAmount(0n), InvalidInputError);
});

test('toBaseUnits / fromBaseUnits round-trip without rounding', () => {
  assert.equal(toBaseUnits('12.5', 2), 1250n);
  assert.equal(toBaseUnits('12', 2), 1200n);
  assert.equal(toBaseUnits('0.01', 2), 1n);
  assert.equal(toBaseUnits('500', 0), 500n);
  assert.throws(() => toBaseUnits('0.001', 2), InvalidInputError);
  assert.throws(() => toBaseUnits('1,5', 2), InvalidInputError);
  assert.equal(fromBaseUnits(1250n, 2), '12.50');
  assert.equal(fromBaseUnits(1n, 2), '0.01');
  assert.equal(fromBaseUnits(500n, 0), '500');
});
