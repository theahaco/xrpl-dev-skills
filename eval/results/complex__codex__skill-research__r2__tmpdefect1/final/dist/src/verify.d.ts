import { Client } from 'xrpl';
export declare const ISSUER = "rHC7MJurChypCr88ZRKXKMf89qxrSiqicX";
export interface Result {
    issuanceId: string;
    holders: {
        A: string;
        B: string;
        C: string;
    };
}
export declare function verify(client: Client, result: Result): Promise<{
    checkedAt: string;
    ledgerIndex: number;
    ledgerHash: string;
    issuer: string;
    issuance: import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance;
    holders: {
        A: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken;
        B: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken;
        C: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken | undefined;
    };
    freezeLimitation: string;
}>;
