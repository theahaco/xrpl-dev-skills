import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromRawAmount, MAX_MPT_RAW_AMOUNT, toRawAmount } from '../src/amount.js';
import { ValidationError } from '../src/errors.js';

test('toRawAmount scales decimals exactly', () => {
  assert.equal(toRawAmount('500', 0), 500n);
  assert.equal(toRawAmount('123.45', 2), 12345n);
  assert.equal(toRawAmount('1.5', 6), 1_500_000n);
  assert.equal(toRawAmount('1.50', 1), 15n, 'trailing zeros beyond scale are fine');
  assert.equal(toRawAmount(MAX_MPT_RAW_AMOUNT.toString(), 0), MAX_MPT_RAW_AMOUNT);
});

test('toRawAmount rejects anything it would have to round or guess', () => {
  for (const bad of ['0', '0.00', '-1', '1.234', '1e3', ' 1', '01', '1.', '.5', '', 'abc', '9223372036854775808']) {
    assert.throws(() => toRawAmount(bad, 2), ValidationError, bad);
  }
  assert.throws(() => toRawAmount(1 as unknown as string, 0), ValidationError);
  assert.throws(() => toRawAmount('1', 19), ValidationError);
});

test('fromRawAmount renders canonical decimals', () => {
  assert.equal(fromRawAmount(0n, 2), '0');
  assert.equal(fromRawAmount('700', 0), '700');
  assert.equal(fromRawAmount(12345n, 2), '123.45');
  assert.equal(fromRawAmount(1_500_000n, 6), '1.5');
  assert.equal(fromRawAmount(5n, 3), '0.005');
});

test('round trip', () => {
  for (const [value, scale] of [['0.001', 3], ['42', 0], ['1000000.25', 2]] as const) {
    assert.equal(fromRawAmount(toRawAmount(value, scale), scale), value);
  }
});
