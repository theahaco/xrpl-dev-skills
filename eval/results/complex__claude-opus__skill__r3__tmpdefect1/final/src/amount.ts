import { ValidationError } from './errors.js';

/**
 * MPT balances are stored on ledger as unsigned 64-bit integers ("raw units")
 * capped at 2^63 - 1. `AssetScale` says how many of those digits are
 * fractional, e.g. with scale 2 the raw amount "12345" means 123.45 tokens.
 *
 * All conversions are done on strings and bigint so no precision is lost.
 */

export const MAX_MPT_RAW_AMOUNT = 0x7fff_ffff_ffff_ffffn;
/** Scales above this cannot represent even one whole token within the 63-bit cap. */
export const MAX_ASSET_SCALE = 18;

const DECIMAL_RE = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export function assertAssetScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_ASSET_SCALE) {
    throw new ValidationError(`AssetScale must be an integer in [0, ${MAX_ASSET_SCALE}], got ${scale}`);
  }
}

/**
 * Converts a human-readable decimal token amount (e.g. "123.45") into raw
 * ledger units. Rejects negative, zero, non-canonical, over-precise and
 * out-of-range values rather than rounding.
 */
export function toRawAmount(amount: string, assetScale: number): bigint {
  assertAssetScale(assetScale);
  if (typeof amount !== 'string') {
    throw new ValidationError('Amount must be a decimal string (numbers are rejected to avoid float rounding)');
  }
  const match = DECIMAL_RE.exec(amount);
  if (!match) {
    throw new ValidationError(`Invalid amount "${amount}": expected a non-negative decimal like "100" or "12.5"`);
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > assetScale) {
    throw new ValidationError(
      `Amount "${amount}" has ${fraction.length} decimal places but the token supports at most ${assetScale}`,
    );
  }
  const raw = BigInt(whole + fraction.padEnd(assetScale, '0'));
  if (raw <= 0n) {
    throw new ValidationError(`Amount must be greater than zero, got "${amount}"`);
  }
  if (raw > MAX_MPT_RAW_AMOUNT) {
    throw new ValidationError(`Amount "${amount}" exceeds the maximum MPT amount`);
  }
  return raw;
}

/** Converts raw ledger units back into a canonical human-readable decimal string. */
export function fromRawAmount(raw: bigint | string, assetScale: number): string {
  assertAssetScale(assetScale);
  const value = typeof raw === 'bigint' ? raw : parseRawAmount(raw);
  if (value < 0n) {
    throw new ValidationError(`Raw amount must be non-negative, got ${value}`);
  }
  if (assetScale === 0) {
    return value.toString();
  }
  const digits = value.toString().padStart(assetScale + 1, '0');
  const whole = digits.slice(0, -assetScale);
  const fraction = digits.slice(-assetScale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Parses a raw amount string as returned by rippled. MPT amounts are
 * returned as base-10 strings in JSON (`MPTAmount`, `OutstandingAmount`).
 */
export function parseRawAmount(raw: string | undefined): bigint {
  if (raw === undefined || raw === '') {
    return 0n;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(`Unexpected raw MPT amount from ledger: "${raw}"`);
  }
  return BigInt(raw);
}
