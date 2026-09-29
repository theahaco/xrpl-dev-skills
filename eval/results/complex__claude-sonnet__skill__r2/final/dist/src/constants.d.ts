/**
 * Flags on the per-holder `MPToken` ledger object.
 *
 * xrpl.js does not export these (only the issuance-level `MPTokenIssuanceFlags`
 * are exported), so they are reproduced here from the XRPL protocol spec:
 * https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken
 */
export declare const MPTOKEN_LSF_LOCKED = 1;
export declare const MPTOKEN_LSF_AUTHORIZED = 2;
/** Default parameters for a new issuance. Callers can override any of these. */
export declare const DEFAULT_ASSET_SCALE = 2;
export declare const DEFAULT_MAXIMUM_AMOUNT = "100000000000";
export declare const DEFAULT_TRANSFER_FEE = 0;
