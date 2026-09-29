import { InvalidArgumentError } from './errors.js'

/** Largest amount an MPT balance or supply can hold on the XRPL (2^63 - 1 base units). */
export const MPT_MAX_AMOUNT = 0x7fffffffffffffffn

/**
 * An MPT amount in the token's smallest unit (an integer). With an AssetScale of `s`,
 * a displayed amount of `1` is `10^s` base units. Strings must be plain base-10 integers.
 */
export type MptAmountInput = bigint | string

/** Parses and validates a strictly positive MPT amount. */
export function parsePositiveAmount(input: MptAmountInput, what = 'amount'): bigint {
  let value: bigint
  if (typeof input === 'bigint') {
    value = input
  } else if (typeof input === 'string' && /^[0-9]+$/.test(input)) {
    value = BigInt(input)
  } else {
    throw new InvalidArgumentError(`${what} must be a bigint or a base-10 integer string, got ${JSON.stringify(input)}`)
  }
  if (value <= 0n) {
    throw new InvalidArgumentError(`${what} must be greater than zero`)
  }
  if (value > MPT_MAX_AMOUNT) {
    throw new InvalidArgumentError(`${what} exceeds the MPT maximum of ${MPT_MAX_AMOUNT}`)
  }
  return value
}

/** Reads an optional ledger amount field; rippled omits zero-valued amount fields. */
export function ledgerAmount(field: unknown): bigint {
  if (field === undefined || field === null) return 0n
  if (typeof field !== 'string' || !/^[0-9]+$/.test(field)) {
    throw new TypeError(`Unexpected MPT amount on ledger: ${JSON.stringify(field)}`)
  }
  return BigInt(field)
}
