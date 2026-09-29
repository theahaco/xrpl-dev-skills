import { InvalidInputError } from './errors.js'

/** Largest amount any MPT balance or issuance can hold on the XRP Ledger (2^63 - 1). */
export const MAX_MPT_AMOUNT = 0x7fff_ffff_ffff_ffffn

/** Largest AssetScale the ledger accepts (UInt8). */
export const MAX_ASSET_SCALE = 255

const DECIMAL = /^(\d+)(?:\.(\d+))?$/

/**
 * Converts a human-readable token amount (e.g. "12.34") into integer base units
 * ("1234" at AssetScale 2). Only plain decimal strings are accepted. JS numbers,
 * exponents and signs are rejected so float rounding can't change the amount.
 */
export function toBaseUnits(amount: string, assetScale: number): bigint {
  assertAssetScale(assetScale)
  const match = DECIMAL.exec(amount)
  if (!match) {
    throw new InvalidInputError(`Amount must be a non-negative decimal string, got ${JSON.stringify(amount)}`)
  }
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > assetScale) {
    throw new InvalidInputError(`Amount ${amount} has more decimal places than the token's AssetScale (${assetScale})`)
  }
  const units = BigInt(whole + fraction.padEnd(assetScale, '0'))
  if (units > MAX_MPT_AMOUNT) {
    throw new InvalidInputError(`Amount ${amount} exceeds the maximum MPT amount`)
  }
  return units
}

/** Converts integer base units back to a human-readable decimal string. */
export function fromBaseUnits(units: bigint, assetScale: number): string {
  assertAssetScale(assetScale)
  if (units < 0n) throw new InvalidInputError('Base units must be non-negative')
  if (assetScale === 0) return units.toString()
  const digits = units.toString().padStart(assetScale + 1, '0')
  const whole = digits.slice(0, -assetScale)
  const fraction = digits.slice(-assetScale).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/** Parses an on-ledger UInt64 amount string; absent fields mean zero. */
export function parseLedgerAmount(value: unknown): bigint {
  if (value === undefined || value === null) return 0n
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`Unexpected ledger amount ${JSON.stringify(value)}`)
  }
  return BigInt(value)
}

function assertAssetScale(assetScale: number): void {
  if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > MAX_ASSET_SCALE) {
    throw new InvalidInputError(`Invalid AssetScale ${assetScale}`)
  }
}
