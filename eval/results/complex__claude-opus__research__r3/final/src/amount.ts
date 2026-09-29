import { InvalidInputError } from './errors.js'

/** Largest raw MPT amount the ledger can represent (2^63 - 1). */
export const MAX_MPT_RAW = (1n << 63n) - 1n

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/
const RAW = /^(0|[1-9][0-9]*)$/

function checkScale(assetScale: number): void {
  if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 255) {
    throw new InvalidInputError(`Invalid asset scale: ${assetScale}`)
  }
}

/**
 * Converts a human-readable token amount (e.g. "12.5") into the raw integer
 * units stored on ledger for an issuance with the given AssetScale.
 *
 * Exact decimal arithmetic only: amounts with more fractional digits than the
 * scale allows are rejected rather than rounded, and zero/negative amounts are
 * rejected. Only plain decimal strings are accepted (no exponents, no numbers)
 * so that callers can't lose precision before the value reaches this function.
 */
export function toRawAmount(amount: string, assetScale: number): bigint {
  checkScale(assetScale)
  if (typeof amount !== 'string') {
    throw new InvalidInputError('Amount must be a decimal string')
  }
  const match = DECIMAL.exec(amount)
  if (!match) {
    throw new InvalidInputError(`Invalid amount "${amount}": expected a positive decimal string`)
  }
  const whole = match[1] ?? '0'
  const fraction = match[2] ?? ''
  if (fraction.length > assetScale) {
    throw new InvalidInputError(
      `Amount "${amount}" has more than ${assetScale} decimal place(s) allowed by the asset scale`,
    )
  }
  const raw = BigInt(whole + fraction.padEnd(assetScale, '0'))
  if (raw <= 0n) {
    throw new InvalidInputError(`Amount must be greater than zero, got "${amount}"`)
  }
  if (raw > MAX_MPT_RAW) {
    throw new InvalidInputError(`Amount "${amount}" exceeds the maximum MPT amount`)
  }
  return raw
}

/** Converts raw on-ledger integer units into a human-readable decimal string. */
export function fromRawAmount(raw: bigint | string, assetScale: number): string {
  checkScale(assetScale)
  const value = typeof raw === 'bigint' ? raw : parseRaw(raw)
  if (value < 0n) {
    throw new InvalidInputError('Raw amount cannot be negative')
  }
  if (assetScale === 0) {
    return value.toString()
  }
  const digits = value.toString().padStart(assetScale + 1, '0')
  const whole = digits.slice(0, -assetScale)
  const fraction = digits.slice(-assetScale).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/** Parses a raw on-ledger amount string (unsigned base-10 integer). */
export function parseRaw(raw: string): bigint {
  if (!RAW.test(raw)) {
    throw new InvalidInputError(`Invalid raw MPT amount "${raw}"`)
  }
  return BigInt(raw)
}
