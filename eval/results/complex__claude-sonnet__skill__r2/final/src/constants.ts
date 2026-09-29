/**
 * Flags on the per-holder `MPToken` ledger object.
 *
 * xrpl.js does not export these (only the issuance-level `MPTokenIssuanceFlags`
 * are exported), so they are reproduced here from the XRPL protocol spec:
 * https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken
 */
export const MPTOKEN_LSF_LOCKED = 0x00000001; // lsfMPTLocked — this holder is frozen
export const MPTOKEN_LSF_AUTHORIZED = 0x00000002; // lsfMPTAuthorized — issuer has approved this holder

/** Default parameters for a new issuance. Callers can override any of these. */
export const DEFAULT_ASSET_SCALE = 2;
export const DEFAULT_MAXIMUM_AMOUNT = "100000000000"; // 10^11 units => 1,000,000,000.00 at scale 2
export const DEFAULT_TRANSFER_FEE = 0;
