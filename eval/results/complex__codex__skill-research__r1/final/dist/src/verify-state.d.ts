import { type Client } from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
export interface DemoResult {
    issuanceId: string;
    holders: Record<'A' | 'B' | 'C', string>;
}
export declare function verify(client: Client, result: DemoResult): Promise<{
    ledgerIndex: number;
    ledgerHash: string;
    issuance: import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance;
    holders: Record<string, MPToken>;
}>;
