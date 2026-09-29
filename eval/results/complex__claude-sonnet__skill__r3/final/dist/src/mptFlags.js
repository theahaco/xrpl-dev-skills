"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MPTokenFlags = void 0;
exports.hasFlag = hasFlag;
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
exports.MPTokenFlags = {
    lsfMPTLocked: 0x00000001,
    lsfMPTAuthorized: 0x00000002,
};
function hasFlag(flags, bit) {
    return (flags & bit) === bit;
}
//# sourceMappingURL=mptFlags.js.map