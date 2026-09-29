/**
 * Exact conversion between human-readable token amounts ("12.34") and the
 * integer base units stored on-ledger (MPTAmount, OutstandingAmount, ...).
 *
 * MPT amounts are unsigned 64-bit integers scaled by the issuance's
 * `AssetScale`. Floating point is never used here: a rounding error in a
 * clawback or issuance amount is a compliance incident.
 */

import { InvalidInputError } from './errors.js'

/** Largest amount an MPT balance or issuance can hold (2^63 - 1). */
export const MAX_MPT_BASE_UNITS = 0x7fff_ffff_ffff_ffffn

/** `AssetScale` is a UInt8 on-ledger, but values above 19 cannot represent 1 whole unit within 2^63 - 1. */
export const MAX_ASSET_SCALE = 19

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/

export function assertValidAssetScale(assetScale: number): void {
  if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > MAX_ASSET_SCALE) {
    throw new InvalidInputError(`assetScale must be an integer between 0 and ${MAX_ASSET_SCALE}, got ${assetScale}`)
  }
}

/**
 * Parse a positive decimal token amount into base units.
 *
 * Rejects zero, negatives, exponents, and more fractional digits than the
 * asset scale allows (rather than silently rounding).
 */
export function toBaseUnits(amount: string, assetScale: number): bigint {
  assertValidAssetScale(assetScale)
  const match = DECIMAL_PATTERN.exec(amount)
  if (!match) {
    throw new InvalidInputError(`amount must be a plain positive decimal string (e.g. "100" or "12.50"), got ${JSON.stringify(amount)}`)
  }
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > assetScale) {
    throw new InvalidInputError(`amount ${amount} has more than ${assetScale} decimal places`)
  }
  const units = BigInt(whole) * 10n ** BigInt(assetScale) + BigInt(fraction.padEnd(assetScale, '0') || '0')
  if (units <= 0n) {
    throw new InvalidInputError(`amount must be greater than zero, got ${amount}`)
  }
  if (units > MAX_MPT_BASE_UNITS) {
    throw new InvalidInputError(`amount ${amount} exceeds the maximum MPT amount`)
  }
  return units
}

/** Format base units as a decimal token amount, trimming trailing fractional zeros. */
export function fromBaseUnits(units: bigint, assetScale: number): string {
  assertValidAssetScale(assetScale)
  if (units < 0n) {
    throw new InvalidInputError(`base units must be non-negative, got ${units}`)
  }
  if (assetScale === 0) {
    return units.toString()
  }
  const divisor = 10n ** BigInt(assetScale)
  const whole = units / divisor
  const fraction = (units % divisor).toString().padStart(assetScale, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

/** Parse an on-ledger UInt64 amount string. Absent fields mean zero. */
export function parseLedgerAmount(value: string | undefined): bigint {
  if (value === undefined) {
    return 0n
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`Unexpected on-ledger amount ${JSON.stringify(value)}`)
  }
  return BigInt(value)
}
