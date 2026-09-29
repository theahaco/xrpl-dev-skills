/** Largest MPT amount the ledger can represent (2^63 - 1). */
export declare const MAX_MPT_AMOUNT: bigint;
/**
 * Convert a display-unit decimal string (e.g. "12.50") into the integer
 * base-unit amount the ledger stores, using the issuance's `AssetScale`.
 * Rejects negative, zero, malformed, over-precise or out-of-range amounts.
 */
export declare function toBaseUnits(amount: string, assetScale: number): bigint;
/** Convert an integer base-unit amount into a display-unit decimal string. */
export declare function fromBaseUnits(raw: bigint, assetScale: number): string;
