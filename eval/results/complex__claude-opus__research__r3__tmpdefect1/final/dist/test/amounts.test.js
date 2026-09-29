import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_MPT_AMOUNT, fromRawAmount, parseRawAmount, toRawAmount } from '../amounts.js';
describe('toRawAmount', () => {
    it('converts whole and fractional amounts', () => {
        assert.equal(toRawAmount('500', 0), 500n);
        assert.equal(toRawAmount('500', 2), 50000n);
        assert.equal(toRawAmount('12.5', 2), 1250n);
        assert.equal(toRawAmount('0.01', 2), 1n);
    });
    it('rejects zero, negative, malformed and over-precise amounts', () => {
        for (const bad of ['0', '0.00', '-1', '1e3', ' 1', '01', '1.', '.5', '', 'abc']) {
            assert.throws(() => toRawAmount(bad, 2), RangeError, bad);
        }
        assert.throws(() => toRawAmount('1.5', 0), RangeError);
        assert.throws(() => toRawAmount('0.001', 2), RangeError);
    });
    it('enforces the protocol maximum', () => {
        assert.equal(toRawAmount(MAX_MPT_AMOUNT.toString(), 0), MAX_MPT_AMOUNT);
        assert.throws(() => toRawAmount((MAX_MPT_AMOUNT + 1n).toString(), 0), RangeError);
    });
    it('rejects invalid scales', () => {
        assert.throws(() => toRawAmount('1', -1), RangeError);
        assert.throws(() => toRawAmount('1', 1.5), RangeError);
        assert.throws(() => toRawAmount('1', 20), RangeError);
    });
});
describe('fromRawAmount', () => {
    it('formats raw amounts without trailing zeros', () => {
        assert.equal(fromRawAmount(0n, 0), '0');
        assert.equal(fromRawAmount(700n, 0), '700');
        assert.equal(fromRawAmount(0n, 2), '0');
        assert.equal(fromRawAmount(1n, 2), '0.01');
        assert.equal(fromRawAmount(1250n, 2), '12.5');
        assert.equal(fromRawAmount(50000n, 2), '500');
    });
    it('round-trips with toRawAmount', () => {
        for (const [display, scale] of [['1', 0], ['123.456', 6], ['0.000001', 6], ['9', 18]]) {
            assert.equal(fromRawAmount(toRawAmount(display, scale), scale), display);
        }
    });
});
describe('parseRawAmount', () => {
    it('treats a missing field as zero (rippled omits zero MPTAmount)', () => {
        assert.equal(parseRawAmount(undefined), 0n);
        assert.equal(parseRawAmount('42'), 42n);
        assert.throws(() => parseRawAmount('-1'), RangeError);
        assert.throws(() => parseRawAmount('1.5'), RangeError);
    });
});
//# sourceMappingURL=amounts.test.js.map