import { ValidationError } from './errors.js'

/** Largest amount an MPT can represent on-ledger (2^63 - 1). */
export const MAX_MPT_AMOUNT = (1n << 63n) - 1n

/**
 * MPT amounts are integers in the token's smallest unit. Accept either a bigint
 * or a base-10 integer string (never a JS number, to avoid silent precision loss).
 * Returns the canonical decimal string used on-ledger.
 */
export function toMptValue(amount: bigint | string): string {
  let value: bigint
  if (typeof amount === 'bigint') {
    value = amount
  } else if (/^[0-9]+$/.test(amount)) {
    value = BigInt(amount)
  } else {
    throw new ValidationError(`Amount must be a non-negative integer string, got ${JSON.stringify(amount)}`)
  }
  if (value <= 0n) throw new ValidationError(`Amount must be positive, got ${value}`)
  if (value > MAX_MPT_AMOUNT) throw new ValidationError(`Amount ${value} exceeds the MPT maximum ${MAX_MPT_AMOUNT}`)
  return value.toString()
}
