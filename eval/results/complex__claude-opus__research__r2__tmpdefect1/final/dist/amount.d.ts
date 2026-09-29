/** Largest amount any MPT balance or issuance can hold on the XRP Ledger (2^63 - 1). */
export declare const MAX_MPT_AMOUNT = 9223372036854775807n;
/** Largest AssetScale the ledger accepts (UInt8). */
export declare const MAX_ASSET_SCALE = 255;
/**
 * Converts a human-readable token amount (e.g. "12.34") into integer base units
 * ("1234" at AssetScale 2). Only plain decimal strings are accepted. JS numbers,
 * exponents and signs are rejected so float rounding can't change the amount.
 */
export declare function toBaseUnits(amount: string, assetScale: number): bigint;
/** Converts integer base units back to a human-readable decimal string. */
export declare function fromBaseUnits(units: bigint, assetScale: number): string;
/** Parses an on-ledger UInt64 amount string; absent fields mean zero. */
export declare function parseLedgerAmount(value: unknown): bigint;
