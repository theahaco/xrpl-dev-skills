import { ValidationError } from './errors.js'

/** Largest amount a single MPT balance (or issuance) can hold: 2^63 - 1. */
export const MAX_MPT_AMOUNT = (1n << 63n) - 1n

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/

/**
 * Converts a human-readable decimal amount (e.g. "12.50") into integer base
 * units for an issuance with the given AssetScale (e.g. 1250n at scale 2).
 * Rejects amounts that are negative, zero, too precise for the scale, or larger than
 * the MPT maximum. Uses bigint throughout, so there is no floating-point rounding.
 */
export function toBaseUnits(amount: string, assetScale: number): bigint {
  assertScale(assetScale)
  const match = DECIMAL.exec(amount)
  if (!match) {
    throw new ValidationError(`Invalid amount "${amount}": expected a non-negative decimal string`)
  }
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > assetScale) {
    throw new ValidationError(
      `Invalid amount "${amount}": at most ${assetScale} decimal place(s) allowed by the token's AssetScale`,
    )
  }
  const units = BigInt(whole + fraction.padEnd(assetScale, '0'))
  if (units <= 0n) throw new ValidationError(`Invalid amount "${amount}": must be greater than zero`)
  if (units > MAX_MPT_AMOUNT) throw new ValidationError(`Invalid amount "${amount}": exceeds the MPT maximum`)
  return units
}

/** Formats integer base units as a decimal string, e.g. 1250n at scale 2 -> "12.5". */
export function fromBaseUnits(units: bigint, assetScale: number): string {
  assertScale(assetScale)
  if (units < 0n) throw new ValidationError('Base units must be non-negative')
  if (assetScale === 0) return units.toString()
  const padded = units.toString().padStart(assetScale + 1, '0')
  const whole = padded.slice(0, -assetScale)
  const fraction = padded.slice(-assetScale).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

function assertScale(assetScale: number): void {
  if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 255) {
    throw new ValidationError(`Invalid AssetScale ${assetScale}`)
  }
}
