import { Client } from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
export declare const ISSUER = "rsGdajs49wqpyofW5LVjWH9ZVJdmWJSEDm";
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
    ledger: number;
    issuance: import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance;
    holders: Record<string, MPToken>;
}>;
