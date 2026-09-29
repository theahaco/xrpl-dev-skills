import { InvalidInputError } from './errors.js'

/** Largest amount of any MPT that can exist: 0x7FFFFFFFFFFFFFFF. */
export const MAX_MPT_AMOUNT = 9_223_372_036_854_775_807n

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/

/**
 * Converts a decimal string (for example "12.34") into integer base units for
 * an issuance with the given AssetScale. Throws if the value is malformed,
 * negative, has more decimals than the scale allows, or is out of range.
 * Numbers are rejected on purpose, to avoid floating-point rounding.
 */
export function toBaseUnits(amount: string, assetScale: number): bigint {
  if (typeof amount !== 'string') {
    throw new InvalidInputError('Amount must be a decimal string, e.g. "100" or "12.50"')
  }
  const match = DECIMAL.exec(amount)
  if (!match) {
    throw new InvalidInputError(`Invalid amount "${amount}": expected a non-negative decimal string`)
  }
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > assetScale) {
    throw new InvalidInputError(
      `Amount "${amount}" has more than ${assetScale} decimal place(s), the token's AssetScale`,
    )
  }
  const units = BigInt(whole + fraction.padEnd(assetScale, '0'))
  if (units > MAX_MPT_AMOUNT) {
    throw new InvalidInputError(`Amount "${amount}" exceeds the maximum MPT amount`)
  }
  return units
}

/** Converts integer base units into a decimal string. Inverse of {@link toBaseUnits}. */
export function fromBaseUnits(units: bigint, assetScale: number): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(assetScale + 1, '0')
  const whole = digits.slice(0, digits.length - assetScale)
  const fraction = digits.slice(digits.length - assetScale).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** Like {@link toBaseUnits}, but also rejects zero. */
export function toPositiveBaseUnits(amount: string, assetScale: number): bigint {
  const units = toBaseUnits(amount, assetScale)
  if (units === 0n) throw new InvalidInputError('Amount must be greater than zero')
  return units
}
