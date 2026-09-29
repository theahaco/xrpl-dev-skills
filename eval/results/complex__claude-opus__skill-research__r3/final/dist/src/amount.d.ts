/** Largest amount a single MPT balance (or issuance) can hold: 2^63 - 1. */
export declare const MAX_MPT_AMOUNT: bigint;
/**
 * Converts a human-readable decimal amount (e.g. "12.50") into integer base
 * units for an issuance with the given AssetScale (e.g. 1250n at scale 2).
 * Rejects amounts that are negative, zero, too precise for the scale, or larger than
 * the MPT maximum. Uses bigint throughout, so there is no floating-point rounding.
 */
export declare function toBaseUnits(amount: string, assetScale: number): bigint;
/** Formats integer base units as a decimal string, e.g. 1250n at scale 2 -> "12.5". */
export declare function fromBaseUnits(units: bigint, assetScale: number): string;
