import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { type SubmittableTransaction as Transaction } from 'xrpl';
import { Ledger, type Signer } from './ledger.js';
export declare const MAX_AMOUNT = "9223372036854775807";
export declare const CAPABILITIES: number;
export declare function amount(value: string): string;
export declare function holder(address: string, issuer: string): string;
export declare function optIn(account: string, issuanceId: string): Transaction;
/** Native MPT locks exempt direct issuer payments (issuance and redemption). This API does not promise absolute immobilization. */
export declare class Issuer {
    readonly ledger: Ledger;
    readonly signer: Signer;
    readonly issuanceId: string;
    constructor(ledger: Ledger, signer: Signer, issuanceId: string);
    static create(ledger: Ledger, signer: Signer, operationId: string): Promise<Issuer>;
    issuance(ledgerIndex?: number | 'validated'): Promise<MPTokenIssuance>;
    holding(address: string, ledgerIndex?: number | 'validated'): Promise<MPToken | undefined>;
    private check;
    private banKey;
    isBanned(address: string): boolean;
    private permitted;
    private send;
    approve(address: string, operationId: string): Promise<import("./ledger.js").Receipt>;
    issue(address: string, value: string, operationId: string): Promise<import("./ledger.js").Receipt>;
    clawback(address: string, value: string, operationId: string): Promise<import("./ledger.js").Receipt>;
    freeze(address: string, operationId: string): Promise<import("./ledger.js").Receipt>;
    unfreeze(address: string, operationId: string): Promise<import("./ledger.js").Receipt>;
    freezeGlobal(operationId: string): Promise<import("./ledger.js").Receipt>;
    unfreezeGlobal(operationId: string): Promise<import("./ledger.js").Receipt>;
    private lock;
    /** Resumable fail-closed workflow. Completion means validated zero balance and revoked authorization. */
    ban(address: string, operationId: string): Promise<void>;
}
