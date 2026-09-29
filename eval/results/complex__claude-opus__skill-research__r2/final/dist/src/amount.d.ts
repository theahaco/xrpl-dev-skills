/**
 * Conversion between human-readable token amounts ("12.34") and the integer
 * base units the ledger stores for an MPT (`MPTAmount`, a UInt64 in string
 * form). `assetScale` is the issuance's `AssetScale`: one whole token equals
 * 10^assetScale base units.
 *
 * All arithmetic uses BigInt; floating point is never used for amounts.
 */
/** Largest value an MPT amount field can hold on the ledger (2^63 - 1). */
export declare const MAX_MPT_AMOUNT: bigint;
/**
 * Parses a non-negative decimal string into base units.
 * Throws if the value has more fractional digits than the asset scale allows
 * (amounts are never silently rounded) or does not fit in an MPT amount.
 */
export declare function toBaseUnits(amount: string, assetScale: number): bigint;
/** Like {@link toBaseUnits} but also rejects zero. */
export declare function toPositiveBaseUnits(amount: string, assetScale: number): bigint;
/** Formats base units as a decimal string with trailing zeros removed. */
export declare function fromBaseUnits(units: bigint | string, assetScale: number): string;
