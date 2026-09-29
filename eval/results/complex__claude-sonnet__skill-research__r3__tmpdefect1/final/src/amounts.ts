/**
 * Decimal <-> base-unit conversion for MPT amounts.
 *
 * MPT ledger amounts are unsigned integer strings ("base units"). An issuance's
 * `AssetScale` says how many of the low-order digits represent the fractional
 * part, e.g. scale 6 means base unit 1_500_000 displays as "1.5". All math here
 * uses BigInt/string manipulation only -- never floating point -- to avoid
 * rounding errors in financial amounts.
 */

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/

/** Converts a human-readable decimal amount (e.g. "500" or "12.34") to a base-unit integer string. */
export function toBaseUnits(humanAmount: string, assetScale: number): string {
  if (!DECIMAL_PATTERN.test(humanAmount)) {
    throw new Error(`Invalid decimal amount: "${humanAmount}"`)
  }

  const [wholePart, fractionPart = ''] = humanAmount.split('.')
  if (fractionPart.length > assetScale) {
    throw new Error(
      `Amount "${humanAmount}" has more decimal places than the asset scale (${assetScale}) allows`,
    )
  }

  const paddedFraction = fractionPart.padEnd(assetScale, '0')
  const baseUnits = BigInt(`${wholePart}${paddedFraction}`)
  return baseUnits.toString()
}

/** Converts a base-unit integer string back to a human-readable decimal amount. */
export function fromBaseUnits(baseAmount: string, assetScale: number): string {
  if (!/^\d+$/.test(baseAmount)) {
    throw new Error(`Invalid base-unit amount: "${baseAmount}"`)
  }
  if (assetScale === 0) {
    return baseAmount
  }

  const padded = baseAmount.padStart(assetScale + 1, '0')
  const wholePart = padded.slice(0, padded.length - assetScale)
  const fractionPart = padded.slice(padded.length - assetScale).replace(/0+$/, '')
  return fractionPart.length > 0 ? `${wholePart}.${fractionPart}` : wholePart
}
