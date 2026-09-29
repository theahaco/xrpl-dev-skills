/**
 * Conversion between human-readable token amounts ("12.34") and the raw
 * integer amounts stored on ledger (MPTAmount), given an issuance's AssetScale.
 *
 * MPT balances are unsigned 64-bit integers on ledger, but the protocol caps
 * every amount at 2^63 - 1. All maths here is done with bigint so no precision
 * is ever lost to floating point.
 */

/** Largest amount the protocol accepts for any single MPT amount/balance. */
export const MAX_MPT_AMOUNT = 2n ** 63n - 1n

/** Largest AssetScale we accept. The field is a UInt8, but anything past 19 digits cannot fit in 2^63 - 1. */
export const MAX_ASSET_SCALE = 19

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/

export function assertAssetScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_ASSET_SCALE) {
    throw new RangeError(`AssetScale must be an integer between 0 and ${MAX_ASSET_SCALE}, got ${scale}`)
  }
}

/**
 * Convert a display amount such as "1000" or "12.5" into the raw on-ledger
 * integer for the given scale. Rejects negative, zero, malformed or
 * over-precise values rather than silently rounding.
 */
export function toRawAmount(display: string, scale: number): bigint {
  assertAssetScale(scale)
  const match = DECIMAL_PATTERN.exec(display)
  if (match === null) {
    throw new RangeError(`Invalid token amount "${display}": expected a non-negative decimal string`)
  }
  const whole = match[1] ?? '0'
  const fraction = match[2] ?? ''
  if (fraction.length > scale) {
    throw new RangeError(
      `Invalid token amount "${display}": more than ${scale} decimal place(s) for this token`,
    )
  }
  const raw = BigInt(whole + fraction.padEnd(scale, '0'))
  if (raw === 0n) {
    throw new RangeError(`Invalid token amount "${display}": must be greater than zero`)
  }
  if (raw > MAX_MPT_AMOUNT) {
    throw new RangeError(`Invalid token amount "${display}": exceeds the protocol maximum`)
  }
  return raw
}

/** Convert a raw on-ledger integer amount into a display string, e.g. 1250n @ scale 2 -> "12.5". */
export function fromRawAmount(raw: bigint, scale: number): string {
  assertAssetScale(scale)
  if (raw < 0n) {
    throw new RangeError(`Raw amount must be non-negative, got ${raw}`)
  }
  if (scale === 0) {
    return raw.toString()
  }
  const digits = raw.toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, -scale)
  const fraction = digits.slice(-scale).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/** Parse an MPTAmount string as returned by rippled (a base-10 integer). */
export function parseRawAmount(value: string | undefined): bigint {
  if (value === undefined) {
    return 0n
  }
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`Unexpected MPT amount from ledger: "${value}"`)
  }
  return BigInt(value)
}
