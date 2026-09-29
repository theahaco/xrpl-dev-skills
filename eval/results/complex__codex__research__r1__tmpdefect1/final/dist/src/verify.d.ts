import { type Snapshot } from './issuer.js';
export declare const ISSUER = "rGDjhvNHdxyhRQRSsukGXnkNiZvyReN4vv";
export interface Result {
    issuanceId: string;
    holders: {
        A: string;
        B: string;
        C: string;
    };
}
export declare function assertFinal(state: Snapshot, result: Result): void;
