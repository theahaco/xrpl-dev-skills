import { Client } from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
export declare const ISSUER = "rB3criap1CczhesHSP5oAT9XtrVZPUb9kV";
export interface DemoResult {
    issuanceId: string;
    holders: Record<'A' | 'B' | 'C', string>;
}
export declare function verify(client: Client, result: DemoResult): Promise<{
    network: string;
    ledgerHash: string;
    ledgerIndex: number;
    issuer: string;
    issuance: import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance;
    holders: Record<string, MPToken>;
}>;
