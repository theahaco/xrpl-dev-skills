import { MptIssuer } from './issuer.js';
import { Runner } from './runtime.js';
export declare function verify(runner: Runner, issuer: MptIssuer, holders: Record<'A' | 'B' | 'C', string>): Promise<{
    verifiedAt: string;
    ledger: number;
    issuance: import("xrpl/dist/npm/models/ledger/MPTokenIssuance.js").MPTokenIssuance;
    holders: {
        A: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken;
        B: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken;
        C: import("xrpl/dist/npm/models/ledger/MPToken.js").MPToken | undefined;
    };
    issuerDepositAuth: boolean;
    bannedC: boolean;
}>;
