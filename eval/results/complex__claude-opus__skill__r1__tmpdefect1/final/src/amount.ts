/**
 * Conversion between human-readable token amounts ("12.34") and the integer
 * base units that MPTs store on-ledger. All arithmetic is done with bigint so
 * no value ever passes through a floating-point number.
 */

/** Largest MPT amount the ledger accepts (0x7FFFFFFFFFFFFFFF). */
export const MAX_MPT_AMOUNT = 0x7fffffffffffffffn

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/

export function assertAssetScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 19) {
    throw new RangeError(`AssetScale must be an integer in [0, 19], got ${scale}`)
  }
}

/**
 * Parse a positive decimal string into base units. Rejects anything that
 * would silently lose precision (more fractional digits than the asset scale),
 * zero, negatives, exponents and values above the ledger maximum.
 */
export function toBaseUnits(amount: string, assetScale: number): bigint {
  assertAssetScale(assetScale)
  const match = DECIMAL.exec(amount)
  if (match === null) {
    throw new RangeError(`Invalid token amount "${amount}": expected a plain positive decimal string`)
  }
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > assetScale) {
    throw new RangeError(`Token amount "${amount}" has more than ${assetScale} decimal places`)
  }
  const units = BigInt(whole + fraction.padEnd(assetScale, '0'))
  if (units <= 0n) {
    throw new RangeError(`Token amount must be greater than zero, got "${amount}"`)
  }
  if (units > MAX_MPT_AMOUNT) {
    throw new RangeError(`Token amount "${amount}" exceeds the maximum MPT amount`)
  }
  return units
}

/** Format base units as a human-readable decimal string. */
export function fromBaseUnits(units: bigint, assetScale: number): string {
  assertAssetScale(assetScale)
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(assetScale + 1, '0')
  const whole = digits.slice(0, digits.length - assetScale)
  const fraction = digits.slice(digits.length - assetScale).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction.length > 0 ? `.${fraction}` : ''}`
}
