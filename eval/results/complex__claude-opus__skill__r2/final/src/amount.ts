import { ValidationError } from './errors'

/** Largest amount an MPT issuance can have outstanding (2^63 - 1 base units). */
export const MAX_MPT_AMOUNT = 0x7fff_ffff_ffff_ffffn

/** An MPT amount in base units: a bigint, or a string of decimal digits. */
export type MptAmountInput = bigint | string

/**
 * Parses and range-checks an amount of base units. Numbers are deliberately not
 * accepted: amounts above 2^53 cannot be represented exactly as JS numbers.
 */
export function parseAmount(value: MptAmountInput, label = 'amount'): bigint {
  let amount: bigint
  if (typeof value === 'bigint') {
    amount = value
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    amount = BigInt(value)
  } else {
    throw new ValidationError(`${label} must be a bigint or a string of decimal digits, got ${JSON.stringify(String(value))}`)
  }
  if (amount <= 0n) throw new ValidationError(`${label} must be greater than zero`)
  if (amount > MAX_MPT_AMOUNT) throw new ValidationError(`${label} exceeds the maximum MPT amount ${MAX_MPT_AMOUNT}`)
  return amount
}

/**
 * Converts a human-readable decimal ("12.34") to base units for an issuance
 * with the given AssetScale (e.g. 1234n for scale 2). Rejects excess precision
 * instead of silently rounding.
 */
export function toBaseUnits(display: string, assetScale: number): bigint {
  if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 255) {
    throw new ValidationError(`Invalid asset scale ${assetScale}`)
  }
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(display)
  if (!match) throw new ValidationError(`Invalid decimal amount ${JSON.stringify(display)}`)
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > assetScale) {
    throw new ValidationError(`${display} has more than ${assetScale} decimal places`)
  }
  return BigInt(whole + fraction.padEnd(assetScale, '0'))
}

/** Inverse of {@link toBaseUnits}. */
export function fromBaseUnits(amount: bigint, assetScale: number): string {
  if (assetScale === 0) return amount.toString()
  const digits = amount.toString().padStart(assetScale + 1, '0')
  const whole = digits.slice(0, -assetScale)
  const fraction = digits.slice(-assetScale).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}
