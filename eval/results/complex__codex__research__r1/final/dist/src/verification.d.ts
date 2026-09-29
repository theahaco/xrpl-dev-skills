import { Client } from 'xrpl';
export interface DemoResult {
    issuanceId: string;
    holders: {
        A: string;
        B: string;
        C: string;
    };
}
export declare const ISSUER_ADDRESS = "rG7kN3XvQ2T3UvSzT55VKLXQjFrGw1LP3f";
export declare const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
/** Pin every read to one validated ledger, so the supply and holder checks are consistent. */
export declare function verifyFinal(client: Client, result: DemoResult): Promise<{
    checkedAt: string;
    ledgerIndex: number;
    ledgerHash: string;
    issuer: string;
    issuerAccount: import("xrpl/dist/npm/models/ledger/AccountRoot.js").default;
    issuance: import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance;
    holders: {
        A: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken;
        B: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken;
        C: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken | undefined;
    };
    policy: string;
}>;
