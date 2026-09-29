/**
 * Conversion between human-readable token amounts ("12.34") and the integer
 * base units the ledger stores for an MPT (`MPTAmount`, a UInt64 in string
 * form). `assetScale` is the issuance's `AssetScale`: one whole token equals
 * 10^assetScale base units.
 *
 * All arithmetic uses BigInt; floating point is never used for amounts.
 */

/** Largest value an MPT amount field can hold on the ledger (2^63 - 1). */
export const MAX_MPT_AMOUNT = (1n << 63n) - 1n

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/

function assertValidScale(assetScale: number): void {
  if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 255) {
    throw new RangeError(`assetScale must be an integer between 0 and 255, got ${assetScale}`)
  }
}

/**
 * Parses a non-negative decimal string into base units.
 * Throws if the value has more fractional digits than the asset scale allows
 * (amounts are never silently rounded) or does not fit in an MPT amount.
 */
export function toBaseUnits(amount: string, assetScale: number): bigint {
  assertValidScale(assetScale)
  const match = DECIMAL_PATTERN.exec(amount)
  if (match === null) {
    throw new RangeError(`Invalid token amount "${amount}": expected a non-negative decimal string`)
  }
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > assetScale) {
    throw new RangeError(
      `Token amount "${amount}" has more than ${assetScale} decimal places allowed by the asset scale`,
    )
  }
  const units = BigInt(whole + fraction.padEnd(assetScale, '0'))
  if (units > MAX_MPT_AMOUNT) {
    throw new RangeError(`Token amount "${amount}" exceeds the maximum MPT amount`)
  }
  return units
}

/** Like {@link toBaseUnits} but also rejects zero. */
export function toPositiveBaseUnits(amount: string, assetScale: number): bigint {
  const units = toBaseUnits(amount, assetScale)
  if (units === 0n) {
    throw new RangeError('Token amount must be greater than zero')
  }
  return units
}

/** Formats base units as a decimal string with trailing zeros removed. */
export function fromBaseUnits(units: bigint | string, assetScale: number): string {
  assertValidScale(assetScale)
  const value = typeof units === 'string' ? BigInt(units) : units
  if (value < 0n) {
    throw new RangeError('MPT amounts cannot be negative')
  }
  if (assetScale === 0) {
    return value.toString()
  }
  const digits = value.toString().padStart(assetScale + 1, '0')
  const whole = digits.slice(0, -assetScale)
  const fraction = digits.slice(-assetScale).replace(/0+$/, '')
  return fraction.length > 0 ? `${whole}.${fraction}` : whole
}
