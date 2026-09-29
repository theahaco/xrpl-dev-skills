import { IssuerError } from './errors.js'

/** Largest amount an MPT can represent (the protocol's 63-bit limit). */
export const MAX_MPT_AMOUNT = 0x7fff_ffff_ffff_ffffn

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/

/**
 * Converts a human-readable decimal token amount (e.g. "12.50") into integer
 * base units using the issuance's AssetScale. Rejects anything that is not a
 * strictly positive amount representable exactly at that scale: silently
 * rounding a compliance action is never acceptable.
 */
export function toBaseUnits(amount: string, assetScale: number): bigint {
  const match = DECIMAL.exec(amount)
  if (match === null) {
    throw new IssuerError('INVALID_AMOUNT', `Amount "${amount}" is not a plain non-negative decimal number`)
  }
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > assetScale) {
    throw new IssuerError('INVALID_AMOUNT', `Amount "${amount}" has more than ${assetScale} decimal places`)
  }
  const units = BigInt(whole + fraction.padEnd(assetScale, '0'))
  if (units <= 0n) {
    throw new IssuerError('INVALID_AMOUNT', `Amount "${amount}" must be greater than zero`)
  }
  if (units > MAX_MPT_AMOUNT) {
    throw new IssuerError('INVALID_AMOUNT', `Amount "${amount}" exceeds the maximum MPT amount`)
  }
  return units
}

/** Converts integer base units back into a decimal string at the given scale. */
export function fromBaseUnits(units: bigint, assetScale: number): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(assetScale + 1, '0')
  const whole = digits.slice(0, digits.length - assetScale)
  const fraction = digits.slice(digits.length - assetScale).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction.length > 0 ? `.${fraction}` : ''}`
}
