import { type Client } from 'xrpl';
import { MptIssuer } from './issuer.js';
export interface DemoResult {
    issuanceId: string;
    holders: {
        A: string;
        B: string;
        C: string;
    };
}
export declare function verifyFinal(client: Client, issuer: MptIssuer, result: DemoResult): Promise<{
    ledgerHash: string;
    ledgerIndex: number;
    issuer: string;
    issuanceId: string;
    issuanceFlags: number;
    globallyFrozen: boolean;
    outstandingAmount: string;
    holders: {
        A: import("./issuer.js").HolderState;
        B: import("./issuer.js").HolderState;
        C: import("./issuer.js").HolderState;
    };
}>;
