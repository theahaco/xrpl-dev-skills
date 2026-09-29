/**
 * Conversion helpers between human-readable decimal amounts and the raw
 * integer base units MPT amendment uses on the wire (AssetScale is purely a
 * display convention; the ledger itself only ever stores/transfers integers).
 *
 * Implemented with BigInt/string math only — never floating point — to avoid
 * rounding errors in financial amounts.
 */
/** Converts a human-readable decimal string (e.g. "500.25") into the raw
 * integer base-unit string an MPT transaction expects, given the issuance's
 * AssetScale (number of decimal places). */
export declare function toBaseUnits(displayAmount: string, assetScale: number): string;
/** Converts a raw integer base-unit string back into a human-readable
 * decimal string, given the issuance's AssetScale. */
export declare function fromBaseUnits(baseUnits: string, assetScale: number): string;
