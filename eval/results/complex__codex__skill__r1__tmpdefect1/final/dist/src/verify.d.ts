import { Client } from 'xrpl';
export interface DemoResult {
    issuanceId: string;
    holders: Record<'A' | 'B' | 'C', string>;
}
export declare function verify(client: Client, result: DemoResult): Promise<{
    network: string;
    ledgerIndex: number;
    ledgerHash: string;
    verifiedAt: string;
    issuance: import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance;
    holders: Record<string, unknown>;
}>;
