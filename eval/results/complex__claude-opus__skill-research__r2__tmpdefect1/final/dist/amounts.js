import { ComplianceError } from './errors.js';
/** Largest MPT amount the ledger can represent (2^63 - 1). */
export const MAX_MPT_AMOUNT = 2n ** 63n - 1n;
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
/**
 * Convert a display-unit decimal string (e.g. "12.50") into the integer
 * base-unit amount the ledger stores, using the issuance's `AssetScale`.
 * Rejects negative, zero, malformed, over-precise or out-of-range amounts.
 */
export function toBaseUnits(amount, assetScale) {
    const match = DECIMAL_PATTERN.exec(amount);
    if (!match) {
        throw new ComplianceError('INVALID_AMOUNT', `Amount "${amount}" is not a non-negative decimal number`);
    }
    const whole = match[1] ?? '0';
    const fraction = match[2] ?? '';
    if (fraction.length > assetScale) {
        throw new ComplianceError('INVALID_AMOUNT', `Amount "${amount}" has more than ${assetScale} decimal place(s), the token's asset scale`);
    }
    const raw = BigInt(whole + fraction.padEnd(assetScale, '0'));
    if (raw <= 0n) {
        throw new ComplianceError('INVALID_AMOUNT', `Amount "${amount}" must be greater than zero`);
    }
    if (raw > MAX_MPT_AMOUNT) {
        throw new ComplianceError('INVALID_AMOUNT', `Amount "${amount}" exceeds the maximum MPT amount`);
    }
    return raw;
}
/** Convert an integer base-unit amount into a display-unit decimal string. */
export function fromBaseUnits(raw, assetScale) {
    if (assetScale === 0)
        return raw.toString();
    const digits = raw.toString().padStart(assetScale + 1, '0');
    const whole = digits.slice(0, -assetScale);
    const fraction = digits.slice(-assetScale).replace(/0+$/, '');
    return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
//# sourceMappingURL=amounts.js.map