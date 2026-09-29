"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const amount_js_1 = require("../src/amount.js");
(0, node_test_1.describe)('toBaseUnits', () => {
    (0, node_test_1.it)('converts whole and fractional amounts', () => {
        strict_1.default.equal((0, amount_js_1.toBaseUnits)('500', 0), 500n);
        strict_1.default.equal((0, amount_js_1.toBaseUnits)('12.34', 2), 1234n);
        strict_1.default.equal((0, amount_js_1.toBaseUnits)('12.3', 2), 1230n);
        strict_1.default.equal((0, amount_js_1.toBaseUnits)('0.000001', 6), 1n);
        strict_1.default.equal((0, amount_js_1.toBaseUnits)('7.50', 1), 75n);
    });
    (0, node_test_1.it)('never rounds: rejects more decimals than the scale', () => {
        strict_1.default.throws(() => (0, amount_js_1.toBaseUnits)('1.001', 2), RangeError);
        strict_1.default.throws(() => (0, amount_js_1.toBaseUnits)('0.5', 0), RangeError);
    });
    (0, node_test_1.it)('rejects malformed, negative and exponent input', () => {
        for (const bad of ['', '-1', '1e3', '01', '1.', '.5', ' 1', 'abc', '1,000']) {
            strict_1.default.throws(() => (0, amount_js_1.toBaseUnits)(bad, 2), RangeError, bad);
        }
    });
    (0, node_test_1.it)('enforces the 2^63-1 ledger maximum', () => {
        strict_1.default.equal((0, amount_js_1.toBaseUnits)(amount_js_1.MAX_MPT_AMOUNT.toString(), 0), amount_js_1.MAX_MPT_AMOUNT);
        strict_1.default.throws(() => (0, amount_js_1.toBaseUnits)((amount_js_1.MAX_MPT_AMOUNT + 1n).toString(), 0), RangeError);
    });
    (0, node_test_1.it)('rejects invalid scales', () => {
        strict_1.default.throws(() => (0, amount_js_1.toBaseUnits)('1', -1), RangeError);
        strict_1.default.throws(() => (0, amount_js_1.toBaseUnits)('1', 1.5), RangeError);
    });
});
(0, node_test_1.describe)('toPositiveBaseUnits', () => {
    (0, node_test_1.it)('rejects zero', () => {
        strict_1.default.throws(() => (0, amount_js_1.toPositiveBaseUnits)('0', 2), RangeError);
        strict_1.default.throws(() => (0, amount_js_1.toPositiveBaseUnits)('0.00', 2), RangeError);
        strict_1.default.equal((0, amount_js_1.toPositiveBaseUnits)('0.01', 2), 1n);
    });
});
(0, node_test_1.describe)('fromBaseUnits', () => {
    (0, node_test_1.it)('formats base units', () => {
        strict_1.default.equal((0, amount_js_1.fromBaseUnits)(500n, 0), '500');
        strict_1.default.equal((0, amount_js_1.fromBaseUnits)('1234', 2), '12.34');
        strict_1.default.equal((0, amount_js_1.fromBaseUnits)(1230n, 2), '12.3');
        strict_1.default.equal((0, amount_js_1.fromBaseUnits)(1200n, 2), '12');
        strict_1.default.equal((0, amount_js_1.fromBaseUnits)(1n, 6), '0.000001');
        strict_1.default.equal((0, amount_js_1.fromBaseUnits)(0n, 4), '0');
    });
    (0, node_test_1.it)('round-trips', () => {
        for (const [value, scale] of [['0.07', 2], ['123456.789', 3], ['9', 0]]) {
            strict_1.default.equal((0, amount_js_1.fromBaseUnits)((0, amount_js_1.toBaseUnits)(value, scale), scale), value);
        }
    });
});
//# sourceMappingURL=amount.test.js.map