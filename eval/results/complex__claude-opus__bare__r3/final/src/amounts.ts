/**
 * Conversion between human-readable token amounts ("1234.56") and the raw
 * integer units stored on ledger (MPTAmount), given an issuance's AssetScale.
 *
 * All arithmetic uses bigint; floating point is never involved.
 */

/** Largest amount an MPT can represent on ledger: 2^63 - 1. */
export const MAX_MPT_AMOUNT = 0x7fffffffffffffffn

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/

/**
 * Parse a positive decimal string into raw ledger units.
 *
 * @throws RangeError if the value is malformed, zero, has more fractional
 *   digits than `assetScale` allows, or exceeds {@link MAX_MPT_AMOUNT}.
 */
export function toRawAmount(value: string, assetScale: number): bigint {
  const match = DECIMAL_RE.exec(value)
  if (match === null) {
    throw new RangeError(`Invalid token amount "${value}": expected a non-negative decimal string`)
  }
  const whole = match[1] ?? '0'
  const fraction = match[2] ?? ''
  const significantFraction = fraction.replace(/0+$/, '')
  if (significantFraction.length > assetScale) {
    throw new RangeError(
      `Invalid token amount "${value}": at most ${assetScale} decimal place(s) allowed`,
    )
  }
  const raw = BigInt(whole + significantFraction.padEnd(assetScale, '0'))
  if (raw <= 0n) {
    throw new RangeError(`Invalid token amount "${value}": must be greater than zero`)
  }
  if (raw > MAX_MPT_AMOUNT) {
    throw new RangeError(`Invalid token amount "${value}": exceeds the MPT maximum`)
  }
  return raw
}

/** Format raw ledger units as a decimal string, e.g. 12345n @ scale 2 -> "123.45". */
export function fromRawAmount(raw: bigint, assetScale: number): string {
  if (raw < 0n) throw new RangeError('Raw MPT amounts cannot be negative')
  if (assetScale === 0) return raw.toString()
  const digits = raw.toString().padStart(assetScale + 1, '0')
  const whole = digits.slice(0, -assetScale)
  const fraction = digits.slice(-assetScale).replace(/0+$/, '')
  return fraction.length > 0 ? `${whole}.${fraction}` : whole
}
