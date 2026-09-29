import { isValidClassicAddress } from 'xrpl';

import { ValidationError } from './errors.js';

/** Largest amount an MPT can represent on the ledger (0x7FFFFFFFFFFFFFFF). */
export const MAX_MPT_AMOUNT = 0x7fff_ffff_ffff_ffffn;

/**
 * An MPT amount in base units (the ledger's integer representation, i.e. before
 * applying AssetScale). Accepts a bigint or a string of decimal digits; JS numbers
 * are deliberately not accepted because they lose precision above 2^53.
 */
export type MptAmount = bigint | string;

/** Parses and validates a strictly positive MPT amount in base units. */
export function parseAmount(amount: MptAmount): bigint {
  let value: bigint;
  if (typeof amount === 'bigint') {
    value = amount;
  } else if (typeof amount === 'string' && /^\d+$/.test(amount)) {
    value = BigInt(amount);
  } else {
    throw new ValidationError(`Amount must be a bigint or a string of decimal digits, got ${JSON.stringify(String(amount))}`);
  }
  if (value <= 0n) throw new ValidationError(`Amount must be positive, got ${value}`);
  if (value > MAX_MPT_AMOUNT) throw new ValidationError(`Amount ${value} exceeds the MPT maximum ${MAX_MPT_AMOUNT}`);
  return value;
}

export function assertClassicAddress(address: string, label = 'address'): void {
  if (typeof address !== 'string' || !isValidClassicAddress(address)) {
    throw new ValidationError(`Invalid ${label}: ${JSON.stringify(address)}`);
  }
}

/** Validates an MPT issuance ID (192-bit hex) and returns it in canonical uppercase form. */
export function normalizeIssuanceId(id: string): string {
  if (typeof id !== 'string' || !/^[0-9A-Fa-f]{48}$/.test(id)) {
    throw new ValidationError(`Invalid MPT issuance ID (expected 48 hex chars): ${JSON.stringify(id)}`);
  }
  return id.toUpperCase();
}
