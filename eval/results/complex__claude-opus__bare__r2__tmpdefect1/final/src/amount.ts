import { InvalidInputError } from './errors.js'

/** Largest amount an MPT can represent on the ledger (2^63 - 1). */
export const MAX_MPT_AMOUNT = 0x7fff_ffff_ffff_ffffn

/** Anything the public API accepts as a token amount, always in integer base units. */
export type AmountInput = bigint | number | string

/**
 * Parses a positive token amount expressed in integer base units
 * (i.e. already multiplied by 10^AssetScale).
 *
 * Rejects fractions, exponents, non-finite and unsafe numbers so that a
 * caller bug can never silently turn into a different on-ledger amount.
 */
export function parseAmount(value: AmountInput, field = 'amount'): bigint {
  let parsed: bigint
  if (typeof value === 'bigint') {
    parsed = value
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidInputError(`${field} must be a safe integer, got ${value}`)
    }
    parsed = BigInt(value)
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    parsed = BigInt(value)
  } else {
    throw new InvalidInputError(`${field} must be a base-10 integer string, got ${JSON.stringify(value)}`)
  }

  if (parsed <= 0n) {
    throw new InvalidInputError(`${field} must be greater than zero, got ${parsed}`)
  }
  if (parsed > MAX_MPT_AMOUNT) {
    throw new InvalidInputError(`${field} exceeds the MPT maximum of ${MAX_MPT_AMOUNT}`)
  }
  return parsed
}

/** Reads an optional on-ledger amount field; absent means zero. */
export function ledgerAmount(value: string | undefined): bigint {
  return value === undefined ? 0n : BigInt(value)
}
