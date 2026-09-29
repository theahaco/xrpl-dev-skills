import { MptIssuer } from './issuer.js';
export declare const ISSUER = "rakJkHNbLGejFB3GZ9XRaYCzeVGHTVuoez";
export interface Result {
    issuanceId: string;
    holders: {
        A: string;
        B: string;
        C: string;
    };
}
export declare function verify(issuer: MptIssuer, result: Result): Promise<{
    ledger: number;
    checkedAt: string;
    issuance: import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance;
    holders: {
        A: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken;
        B: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken;
        C: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken | undefined;
    };
}>;
