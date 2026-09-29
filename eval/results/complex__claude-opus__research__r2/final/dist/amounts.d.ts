/**
 * Conversion between human-readable token amounts ("12.50") and the integer
 * base units that the XRP Ledger stores for MPTs.
 *
 * MPT balances are unsigned 64-bit integers capped at 2^63 - 1. The issuance's
 * AssetScale says where the decimal point sits when displaying them: with a
 * scale of 2, a ledger value of "1250" means 12.50 tokens.
 *
 * All arithmetic uses bigint so no precision is lost.
 */
/** Largest amount of an MPT that can exist in one place (2^63 - 1). */
export declare const MAX_MPT_AMOUNT: bigint;
/** Largest AssetScale value the ledger accepts (UInt8). */
export declare const MAX_ASSET_SCALE = 255;
export declare class AmountError extends Error {
    readonly name = "AmountError";
}
export declare function assertAssetScale(scale: number): void;
/**
 * Parse a positive, human-readable decimal amount into base units.
 *
 * Accepts only plain decimal strings (no signs, exponents or separators) so
 * that an amount from an upstream system is never silently reinterpreted.
 * Rejects amounts that are zero, have more fractional digits than the scale
 * allows, or exceed the 63-bit ledger limit.
 */
export declare function toBaseUnits(amount: string, assetScale: number): bigint;
/** Format base units as a human-readable decimal string, trimming trailing zeros. */
export declare function fromBaseUnits(units: bigint | string, assetScale: number): string;
/**
 * Parse an amount field read from the ledger (MPTAmount, OutstandingAmount…).
 * These are unsigned base-10 integer strings.
 */
export declare function parseLedgerAmount(value: string | undefined): bigint;
