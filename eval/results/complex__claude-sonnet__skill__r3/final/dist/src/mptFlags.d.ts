/**
 * Bit flag constants for the MPT amendment's ledger objects.
 *
 * The `MPTokenIssuance` object's `lsfMPTLocked` flag is exposed as an enum by
 * the xrpl.js SDK. The per-holder `MPToken` object's flags are NOT currently
 * typed by the SDK (its `Flags` field is just `number`), so the bit values
 * below are taken from the XRPL MPT specification and confirmed empirically
 * against testnet while building this module:
 *   - lsfMPTLocked     (0x0001): this holder is individually frozen.
 *   - lsfMPTAuthorized (0x0002): the issuer has authorized this holder
 *     (only meaningful when the issuance has lsfMPTRequireAuth set).
 */
export declare const MPTokenFlags: {
    readonly lsfMPTLocked: 1;
    readonly lsfMPTAuthorized: 2;
};
export declare function hasFlag(flags: number, bit: number): boolean;
