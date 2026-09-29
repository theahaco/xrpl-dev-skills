import { Client } from 'xrpl';
export declare const ISSUER = "rnS9o1Trk4KyspmMjGeWFBdpwhhGprFFh1";
export interface Result {
    issuanceId: string;
    holders: {
        A: string;
        B: string;
        C: string;
    };
}
export declare function verify(client: Client, result: Result): Promise<{
    verifiedAt: string;
    ledgerHash: string;
    ledgerIndex: number;
    issuance: import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance;
    holders: Record<string, unknown>;
    issuer: import("xrpl/dist/npm/models/ledger/AccountRoot.js").default;
}>;
