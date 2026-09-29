"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_MPT_AMOUNT = void 0;
exports.toBaseUnits = toBaseUnits;
exports.fromBaseUnits = fromBaseUnits;
const errors_js_1 = require("./errors.js");
/** Largest amount a single MPT balance (or issuance) can hold: 2^63 - 1. */
exports.MAX_MPT_AMOUNT = (1n << 63n) - 1n;
const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
/**
 * Converts a human-readable decimal amount (e.g. "12.50") into integer base
 * units for an issuance with the given AssetScale (e.g. 1250n at scale 2).
 * Rejects amounts that are negative, zero, too precise for the scale, or larger than
 * the MPT maximum. Uses bigint throughout, so there is no floating-point rounding.
 */
function toBaseUnits(amount, assetScale) {
    assertScale(assetScale);
    const match = DECIMAL.exec(amount);
    if (!match) {
        throw new errors_js_1.ValidationError(`Invalid amount "${amount}": expected a non-negative decimal string`);
    }
    const whole = match[1] ?? '0';
    const fraction = (match[2] ?? '').replace(/0+$/, '');
    if (fraction.length > assetScale) {
        throw new errors_js_1.ValidationError(`Invalid amount "${amount}": at most ${assetScale} decimal place(s) allowed by the token's AssetScale`);
    }
    const units = BigInt(whole + fraction.padEnd(assetScale, '0'));
    if (units <= 0n)
        throw new errors_js_1.ValidationError(`Invalid amount "${amount}": must be greater than zero`);
    if (units > exports.MAX_MPT_AMOUNT)
        throw new errors_js_1.ValidationError(`Invalid amount "${amount}": exceeds the MPT maximum`);
    return units;
}
/** Formats integer base units as a decimal string, e.g. 1250n at scale 2 -> "12.5". */
function fromBaseUnits(units, assetScale) {
    assertScale(assetScale);
    if (units < 0n)
        throw new errors_js_1.ValidationError('Base units must be non-negative');
    if (assetScale === 0)
        return units.toString();
    const padded = units.toString().padStart(assetScale + 1, '0');
    const whole = padded.slice(0, -assetScale);
    const fraction = padded.slice(-assetScale).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}
function assertScale(assetScale) {
    if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 255) {
        throw new errors_js_1.ValidationError(`Invalid AssetScale ${assetScale}`);
    }
}
//# sourceMappingURL=amount.js.map