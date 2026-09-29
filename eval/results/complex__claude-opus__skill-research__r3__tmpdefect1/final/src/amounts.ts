import { ComplianceViolationError } from './errors.js'

/** Largest MPT amount the ledger accepts (2^63 - 1), in base units. */
export const MAX_MPT_AMOUNT = (1n << 63n) - 1n

/** Largest `AssetScale` we accept. `MAX_MPT_AMOUNT` has 19 digits. */
export const MAX_ASSET_SCALE = 19

/**
 * Converts a human-readable decimal token amount (e.g. `"12.50"`) into ledger
 * base units for an issuance with the given `AssetScale`. Throws if the amount
 * isn't positive, has more decimal places than the scale allows, or exceeds
 * the ledger maximum. Numbers aren't accepted, to avoid floating-point loss.
 */
export function toBaseUnits(amount: string, assetScale: number): bigint {
  assertAssetScale(assetScale)
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(amount)
  if (!match) {
    throw new ComplianceViolationError(
      'INVALID_AMOUNT',
      `Amount "${amount}" is not a non-negative decimal string`,
    )
  }
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').replace(/0+$/u, '')
  if (fraction.length > assetScale) {
    throw new ComplianceViolationError(
      'INVALID_AMOUNT',
      `Amount "${amount}" has more than ${assetScale} decimal places`,
    )
  }
  const base = BigInt(whole + fraction.padEnd(assetScale, '0'))
  if (base <= 0n) {
    throw new ComplianceViolationError('INVALID_AMOUNT', `Amount "${amount}" must be greater than zero`)
  }
  if (base > MAX_MPT_AMOUNT) {
    throw new ComplianceViolationError('INVALID_AMOUNT', `Amount "${amount}" exceeds the MPT maximum`)
  }
  return base
}

/** Converts ledger base units back into a decimal string, e.g. `1250n` at scale 2 → `"12.5"`. */
export function fromBaseUnits(base: bigint, assetScale: number): string {
  assertAssetScale(assetScale)
  if (base < 0n) throw new RangeError('Base-unit amount must not be negative')
  if (assetScale === 0) return base.toString()
  const digits = base.toString().padStart(assetScale + 1, '0')
  const whole = digits.slice(0, -assetScale)
  const fraction = digits.slice(-assetScale).replace(/0+$/u, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/** Parses an `MPTAmount` ledger field; the ledger omits the field when the balance is zero. */
export function parseLedgerAmount(value: string | undefined): bigint {
  if (value === undefined) return 0n
  if (!/^\d+$/u.test(value)) throw new RangeError(`Unexpected ledger amount "${value}"`)
  return BigInt(value)
}

function assertAssetScale(assetScale: number): void {
  if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > MAX_ASSET_SCALE) {
    throw new RangeError(`AssetScale must be an integer between 0 and ${MAX_ASSET_SCALE}`)
  }
}
