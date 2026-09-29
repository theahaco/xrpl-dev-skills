import { MptIssuer } from './issuer.js';
export interface DemoResult {
    issuanceId: string;
    holders: {
        A: string;
        B: string;
        C: string;
    };
}
export declare function verify(issuer: MptIssuer, result: DemoResult): Promise<{
    ledgerHash: string;
    ledgerIndex: number;
    issuer: string;
    flags: number;
    outstandingAmount: string;
    A: import("./issuer.js").HolderState;
    B: import("./issuer.js").HolderState;
    C: import("./issuer.js").HolderState;
}>;
