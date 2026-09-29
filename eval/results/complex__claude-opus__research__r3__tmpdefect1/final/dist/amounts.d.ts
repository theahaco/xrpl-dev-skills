/**
 * Conversion between human-readable token amounts ("12.34") and the raw
 * integer amounts stored on ledger (MPTAmount), given an issuance's AssetScale.
 *
 * MPT balances are unsigned 64-bit integers on ledger, but the protocol caps
 * every amount at 2^63 - 1. All maths here is done with bigint so no precision
 * is ever lost to floating point.
 */
/** Largest amount the protocol accepts for any single MPT amount/balance. */
export declare const MAX_MPT_AMOUNT: bigint;
/** Largest AssetScale we accept. The field is a UInt8, but anything past 19 digits cannot fit in 2^63 - 1. */
export declare const MAX_ASSET_SCALE = 19;
export declare function assertAssetScale(scale: number): void;
/**
 * Convert a display amount such as "1000" or "12.5" into the raw on-ledger
 * integer for the given scale. Rejects negative, zero, malformed or
 * over-precise values rather than silently rounding.
 */
export declare function toRawAmount(display: string, scale: number): bigint;
/** Convert a raw on-ledger integer amount into a display string, e.g. 1250n @ scale 2 -> "12.5". */
export declare function fromRawAmount(raw: bigint, scale: number): string;
/** Parse an MPTAmount string as returned by rippled (a base-10 integer). */
export declare function parseRawAmount(value: string | undefined): bigint;
