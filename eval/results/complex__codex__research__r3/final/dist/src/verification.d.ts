import { MptIssuer } from './issuer.js';
export interface Result {
    issuanceId: string;
    holders: {
        A: string;
        B: string;
        C: string;
    };
}
export declare function verify(issuer: MptIssuer, result: Result): Promise<unknown>;
