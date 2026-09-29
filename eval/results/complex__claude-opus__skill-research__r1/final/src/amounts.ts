import { MptIssuerError } from './errors.js'

/** Largest balance an MPToken can hold: 2^63 - 1 base units. */
export const MAX_MPT_AMOUNT = 2n ** 63n - 1n

/** Largest AssetScale the ledger accepts (UInt8), capped to what's representable. */
const MAX_ASSET_SCALE = 19

const INTEGER = /^(0|[1-9]\d*)$/
const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/

/**
 * An MPT amount in base (smallest, indivisible) units. Accepted as a bigint or a
 * base-10 integer string; numbers are rejected to avoid silent precision loss.
 */
export type BaseUnits = bigint | string

/** Parse and range-check an amount in base units. Zero is rejected unless allowZero. */
export function parseBaseUnits(amount: BaseUnits, { allowZero = false } = {}): bigint {
  let value: bigint
  if (typeof amount === 'bigint') {
    value = amount
  } else if (typeof amount === 'string' && INTEGER.test(amount)) {
    value = BigInt(amount)
  } else {
    throw new MptIssuerError(`Invalid MPT amount ${JSON.stringify(amount)}: expected a non-negative integer in base units`)
  }
  if (value < 0n || value > MAX_MPT_AMOUNT) {
    throw new MptIssuerError(`MPT amount ${value} is outside the range 0..${MAX_MPT_AMOUNT}`)
  }
  if (value === 0n && !allowZero) {
    throw new MptIssuerError('MPT amount must be greater than zero')
  }
  return value
}

function checkScale(assetScale: number): void {
  if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > MAX_ASSET_SCALE) {
    throw new MptIssuerError(`Invalid asset scale ${assetScale}`)
  }
}

/**
 * Convert a human-readable decimal amount (e.g. "12.34") to base units for the
 * given AssetScale. Throws rather than rounding if the value has too many decimals.
 */
export function toBaseUnits(display: string, assetScale: number): bigint {
  checkScale(assetScale)
  if (!DECIMAL.test(display)) {
    throw new MptIssuerError(`Invalid decimal amount ${JSON.stringify(display)}`)
  }
  const [whole = '0', fraction = ''] = display.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  if (trimmed.length > assetScale) {
    throw new MptIssuerError(`${display} has more than ${assetScale} decimal places`)
  }
  return parseBaseUnits(BigInt(whole + trimmed.padEnd(assetScale, '0')), { allowZero: true })
}

/** Format base units as a human-readable decimal string for the given AssetScale. */
export function formatBaseUnits(amount: bigint, assetScale: number): string {
  checkScale(assetScale)
  if (assetScale === 0) return amount.toString()
  const digits = amount.toString().padStart(assetScale + 1, '0')
  const whole = digits.slice(0, -assetScale)
  const fraction = digits.slice(-assetScale).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}
