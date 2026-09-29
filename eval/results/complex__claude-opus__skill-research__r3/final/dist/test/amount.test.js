"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const index_js_1 = require("../src/index.js");
(0, node_test_1.test)('toBaseUnits scales decimal strings exactly', () => {
    strict_1.default.equal((0, index_js_1.toBaseUnits)('500', 2), 50000n);
    strict_1.default.equal((0, index_js_1.toBaseUnits)('12.5', 2), 1250n);
    strict_1.default.equal((0, index_js_1.toBaseUnits)('0.01', 2), 1n);
    strict_1.default.equal((0, index_js_1.toBaseUnits)('1.10', 1), 11n); // trailing zeros beyond the scale are fine
    strict_1.default.equal((0, index_js_1.toBaseUnits)('7', 0), 7n);
});
(0, node_test_1.test)('toBaseUnits rejects invalid amounts', () => {
    for (const bad of ['', '-1', '0', '0.00', '1.001', '1e3', ' 1', '01', 'abc', '1.']) {
        strict_1.default.throws(() => (0, index_js_1.toBaseUnits)(bad, 2), index_js_1.ValidationError, bad);
    }
    strict_1.default.throws(() => (0, index_js_1.toBaseUnits)((index_js_1.MAX_MPT_AMOUNT + 1n).toString(), 0), index_js_1.ValidationError);
    strict_1.default.equal((0, index_js_1.toBaseUnits)(index_js_1.MAX_MPT_AMOUNT.toString(), 0), index_js_1.MAX_MPT_AMOUNT);
});
(0, node_test_1.test)('fromBaseUnits formats without floating point', () => {
    strict_1.default.equal((0, index_js_1.fromBaseUnits)(50000n, 2), '500');
    strict_1.default.equal((0, index_js_1.fromBaseUnits)(1250n, 2), '12.5');
    strict_1.default.equal((0, index_js_1.fromBaseUnits)(1n, 2), '0.01');
    strict_1.default.equal((0, index_js_1.fromBaseUnits)(0n, 2), '0');
    strict_1.default.equal((0, index_js_1.fromBaseUnits)(index_js_1.MAX_MPT_AMOUNT, 6), '9223372036854.775807');
});
//# sourceMappingURL=amount.test.js.map