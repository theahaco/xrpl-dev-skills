import { InvalidInputError } from './errors.js';

/**
 * MPT amounts on the XRP Ledger are unsigned 64-bit integers in the token's
 * smallest unit, capped at 2^63 - 1. `AssetScale` only affects how the amount
 * is displayed (value = units / 10^AssetScale).
 *
 * This module represents all on-ledger amounts as `bigint` base units, so there
 * is never any floating-point rounding.
 */
export const MAX_MPT_AMOUNT = 0x7fff_ffff_ffff_ffffn;

export type AmountInput = bigint | string;

/** Parse and validate a strictly positive base-unit amount. */
export function parsePositiveAmount(input: AmountInput, field = 'amount'): bigint {
  const value = parseAmount(input, field);
  if (value === 0n) throw new InvalidInputError(`${field} must be greater than zero`);
  return value;
}

/** Parse and validate a non-negative base-unit amount. */
export function parseAmount(input: AmountInput, field = 'amount'): bigint {
  let value: bigint;
  if (typeof input === 'bigint') {
    value = input;
  } else if (typeof input === 'string' && /^(0|[1-9]\d*)$/.test(input)) {
    value = BigInt(input);
  } else {
    throw new InvalidInputError(
      `${field} must be a bigint or a base-10 integer string of base units, got ${JSON.stringify(String(input))}`,
    );
  }
  if (value < 0n) throw new InvalidInputError(`${field} must not be negative`);
  if (value > MAX_MPT_AMOUNT) throw new InvalidInputError(`${field} exceeds the MPT maximum of ${MAX_MPT_AMOUNT}`);
  return value;
}

/** Parse an amount read from the ledger (absent means zero). */
export function ledgerAmount(value: string | undefined): bigint {
  return value === undefined ? 0n : BigInt(value);
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 255) {
    throw new InvalidInputError(`assetScale must be an integer in [0, 255], got ${scale}`);
  }
}

/**
 * Convert a human-readable decimal string (for example "12.50") to base units
 * for a given AssetScale. Rejects values with more decimal places than the
 * scale allows, rather than silently rounding.
 */
export function toBaseUnits(display: string, assetScale: number): bigint {
  assertScale(assetScale);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(display);
  if (!match) throw new InvalidInputError(`Invalid decimal amount ${JSON.stringify(display)}`);
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > assetScale) {
    throw new InvalidInputError(`${display} has more than ${assetScale} decimal places`);
  }
  return parseAmount(BigInt(whole + frac.padEnd(assetScale, '0')));
}

/** Format base units as a decimal string for display. */
export function fromBaseUnits(units: bigint, assetScale: number): string {
  assertScale(assetScale);
  if (units < 0n) throw new InvalidInputError('units must not be negative');
  if (assetScale === 0) return units.toString();
  const s = units.toString().padStart(assetScale + 1, '0');
  return `${s.slice(0, -assetScale)}.${s.slice(-assetScale)}`;
}
