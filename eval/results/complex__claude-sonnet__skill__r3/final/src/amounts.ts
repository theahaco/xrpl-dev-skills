/**
 * Conversion helpers between human-readable decimal amounts and the raw
 * integer base units MPT amendment uses on the wire (AssetScale is purely a
 * display convention; the ledger itself only ever stores/transfers integers).
 *
 * Implemented with BigInt/string math only — never floating point — to avoid
 * rounding errors in financial amounts.
 */

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/** Converts a human-readable decimal string (e.g. "500.25") into the raw
 * integer base-unit string an MPT transaction expects, given the issuance's
 * AssetScale (number of decimal places). */
export function toBaseUnits(displayAmount: string, assetScale: number): string {
  if (!DECIMAL_PATTERN.test(displayAmount)) {
    throw new Error(`Invalid decimal amount: "${displayAmount}"`);
  }
  const [whole = "0", frac = ""] = displayAmount.split(".");
  if (frac.length > assetScale) {
    throw new Error(
      `Amount "${displayAmount}" has more decimal places than assetScale ${assetScale} allows`,
    );
  }
  const paddedFrac = frac.padEnd(assetScale, "0");
  const combined = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, "");
  return BigInt(combined).toString();
}

/** Converts a raw integer base-unit string back into a human-readable
 * decimal string, given the issuance's AssetScale. */
export function fromBaseUnits(baseUnits: string, assetScale: number): string {
  const value = BigInt(baseUnits);
  if (assetScale === 0) {
    return value.toString();
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(assetScale + 1, "0");
  const whole = digits.slice(0, digits.length - assetScale);
  const frac = digits.slice(digits.length - assetScale).replace(/0+$/, "");
  const result = frac.length > 0 ? `${whole}.${frac}` : whole;
  return negative ? `-${result}` : result;
}
