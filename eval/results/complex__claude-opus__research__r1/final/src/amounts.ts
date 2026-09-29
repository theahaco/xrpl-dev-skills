import { InvalidArgumentError } from './errors.js'

/** Largest MPT amount the ledger can represent: 2^63 - 1. */
export const MAX_MPT_AMOUNT = (1n << 63n) - 1n

/**
 * An MPT amount in the token's smallest on-ledger unit. MPT amounts on the
 * XRP Ledger are unsigned 63-bit integers. Divide by 10^AssetScale for display.
 *
 * Accepted as a `bigint` or a base-10 integer string so values beyond
 * Number.MAX_SAFE_INTEGER are never silently rounded.
 */
export type MptAmount = bigint | string

/**
 * Validates and normalises an amount to a bigint in [1, 2^63 - 1].
 * Rejects numbers, decimals, signs, exponents and leading zeros rather than
 * guessing what the caller meant.
 */
export function parsePositiveAmount(amount: MptAmount, what = 'amount'): bigint {
  let value: bigint
  if (typeof amount === 'bigint') {
    value = amount
  } else if (typeof amount === 'string' && /^(0|[1-9][0-9]*)$/.test(amount)) {
    value = BigInt(amount)
  } else {
    throw new InvalidArgumentError(
      `${what} must be a bigint or a base-10 integer string in the token's smallest unit, got ${JSON.stringify(
        typeof amount === 'string' ? amount : String(amount),
      )}`,
    )
  }
  if (value <= 0n) {
    throw new InvalidArgumentError(`${what} must be greater than zero, got ${value}`)
  }
  if (value > MAX_MPT_AMOUNT) {
    throw new InvalidArgumentError(`${what} exceeds the MPT maximum of ${MAX_MPT_AMOUNT}, got ${value}`)
  }
  return value
}
