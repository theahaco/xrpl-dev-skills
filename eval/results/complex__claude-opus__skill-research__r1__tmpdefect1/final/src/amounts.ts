import { ComplianceError } from './errors.js';

/** Largest amount an MPT balance or issuance can hold on-ledger (2^63 - 1). */
export const MAX_MPT_AMOUNT = 0x7fff_ffff_ffff_ffffn;

/** Largest AssetScale that is safe to use with this module. */
export const MAX_ASSET_SCALE = 18;

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Converts a human-readable token amount (e.g. "12.34") into the integer
 * number of base units stored on-ledger for an issuance with `assetScale`
 * decimal places. Uses exact integer arithmetic; never floats.
 *
 * Rejects zero, negatives, exponents, more decimals than `assetScale`, and
 * values above the ledger maximum.
 */
export function toBaseUnits(amount: string, assetScale: number): bigint {
  assertAssetScale(assetScale);
  const match = DECIMAL.exec(amount);
  if (!match) {
    throw new ComplianceError('INVALID_INPUT', `Invalid token amount "${amount}": expected a plain decimal string`);
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > assetScale) {
    throw new ComplianceError(
      'INVALID_INPUT',
      `Token amount "${amount}" has more than ${assetScale} decimal place(s), the token's AssetScale`,
    );
  }
  const units = BigInt(whole) * 10n ** BigInt(assetScale) + BigInt(fraction.padEnd(assetScale, '0') || '0');
  if (units <= 0n) {
    throw new ComplianceError('INVALID_INPUT', `Token amount must be positive, got "${amount}"`);
  }
  if (units > MAX_MPT_AMOUNT) {
    throw new ComplianceError('INVALID_INPUT', `Token amount "${amount}" exceeds the ledger maximum`);
  }
  return units;
}

/** Formats an on-ledger integer amount as a human-readable decimal string. */
export function fromBaseUnits(units: bigint, assetScale: number): string {
  assertAssetScale(assetScale);
  if (units < 0n) throw new RangeError(`Negative MPT amount ${units}`);
  if (assetScale === 0) return units.toString();
  const digits = units.toString().padStart(assetScale + 1, '0');
  const whole = digits.slice(0, -assetScale);
  const fraction = digits.slice(-assetScale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Parses an on-ledger UInt64 amount string (absent means zero). */
export function parseLedgerAmount(value: string | undefined): bigint {
  if (value === undefined) return 0n;
  if (!/^\d+$/.test(value)) throw new Error(`Unexpected MPT amount "${value}" from ledger`);
  return BigInt(value);
}

function assertAssetScale(assetScale: number): void {
  if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > MAX_ASSET_SCALE) {
    throw new ComplianceError('INVALID_INPUT', `AssetScale must be an integer from 0 to ${MAX_ASSET_SCALE}`);
  }
}
