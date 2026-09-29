/**
 * Conversion between human-readable token amounts ("12.50") and the integer
 * base units that the XRP Ledger stores for MPTs.
 *
 * MPT balances are unsigned 64-bit integers capped at 2^63 - 1. The issuance's
 * AssetScale says where the decimal point sits when displaying them: with a
 * scale of 2, a ledger value of "1250" means 12.50 tokens.
 *
 * All arithmetic uses bigint so no precision is lost.
 */
/** Largest amount of an MPT that can exist in one place (2^63 - 1). */
export const MAX_MPT_AMOUNT = (1n << 63n) - 1n;
/** Largest AssetScale value the ledger accepts (UInt8). */
export const MAX_ASSET_SCALE = 255;
const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;
export class AmountError extends Error {
    name = 'AmountError';
}
export function assertAssetScale(scale) {
    if (!Number.isInteger(scale) || scale < 0 || scale > MAX_ASSET_SCALE) {
        throw new AmountError(`AssetScale must be an integer in [0, ${MAX_ASSET_SCALE}], got ${scale}`);
    }
}
/**
 * Parse a positive, human-readable decimal amount into base units.
 *
 * Accepts only plain decimal strings (no signs, exponents or separators) so
 * that an amount from an upstream system is never silently reinterpreted.
 * Rejects amounts that are zero, have more fractional digits than the scale
 * allows, or exceed the 63-bit ledger limit.
 */
export function toBaseUnits(amount, assetScale) {
    assertAssetScale(assetScale);
    const match = DECIMAL_PATTERN.exec(amount);
    if (match === null) {
        throw new AmountError(`Amount must be a plain decimal string such as "100" or "12.5", got "${amount}"`);
    }
    const whole = match[1] ?? '0';
    const fraction = (match[2] ?? '').replace(/0+$/, '');
    if (fraction.length > assetScale) {
        throw new AmountError(`Amount "${amount}" has ${fraction.length} decimal places, but this token only supports ${assetScale}`);
    }
    const units = BigInt(whole + fraction.padEnd(assetScale, '0'));
    if (units === 0n) {
        throw new AmountError('Amount must be greater than zero');
    }
    if (units > MAX_MPT_AMOUNT) {
        throw new AmountError(`Amount "${amount}" exceeds the maximum MPT amount`);
    }
    return units;
}
/** Format base units as a human-readable decimal string, trimming trailing zeros. */
export function fromBaseUnits(units, assetScale) {
    assertAssetScale(assetScale);
    const value = typeof units === 'string' ? parseLedgerAmount(units) : units;
    if (value < 0n) {
        throw new AmountError(`Base-unit amount must not be negative, got ${value}`);
    }
    if (assetScale === 0) {
        return value.toString();
    }
    const digits = value.toString().padStart(assetScale + 1, '0');
    const whole = digits.slice(0, -assetScale);
    const fraction = digits.slice(-assetScale).replace(/0+$/, '');
    return fraction === '' ? whole : `${whole}.${fraction}`;
}
/**
 * Parse an amount field read from the ledger (MPTAmount, OutstandingAmount…).
 * These are unsigned base-10 integer strings.
 */
export function parseLedgerAmount(value) {
    if (value === undefined) {
        return 0n;
    }
    if (!/^\d+$/.test(value)) {
        throw new AmountError(`Unexpected ledger amount "${value}"`);
    }
    return BigInt(value);
}
//# sourceMappingURL=amounts.js.map