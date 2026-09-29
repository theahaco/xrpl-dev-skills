import { Client } from 'xrpl';
export interface DemoResult {
    issuanceId: string;
    holders: {
        A: string;
        B: string;
        C: string;
    };
}
export declare const ISSUER_ADDRESS = "rNGckWk5JV2Y3UvY4CQdLMBKP5VBivkDUU";
export declare function verify(client: Client, result: DemoResult): Promise<{
    verifiedAt: string;
    ledgerIndex: number;
    issuance: import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance;
    A: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken;
    B: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken;
    C: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken | undefined;
}>;
