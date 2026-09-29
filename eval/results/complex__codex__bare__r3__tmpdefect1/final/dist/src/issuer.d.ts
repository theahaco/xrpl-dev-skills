import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { LedgerExecutor, type Signer } from './ledger.js';
export declare const MAX_MPT_AMOUNT = "9223372036854775807";
export declare const ISSUANCE_FLAGS: number;
export declare const HOLDER_LOCKED = 1;
export declare const HOLDER_AUTHORIZED = 2;
export declare function amount(value: string): string;
export interface HolderState {
    balance: string;
    authorized: boolean;
    frozen: boolean;
    exists: boolean;
}
export interface Ban {
    status: 'pending' | 'complete';
    reason: string;
    operationId: string;
}
/** Classic transparent MPT, scale 0. KYC decisions are supplied by the backend. */
export declare class MptIssuer {
    readonly ledger: LedgerExecutor;
    readonly signer: Signer;
    readonly issuanceId: string;
    constructor(ledger: LedgerExecutor, signer: Signer, issuanceId: string);
    static create(ledger: LedgerExecutor, signer: Signer, operationId: string): Promise<MptIssuer>;
    issuance(ledgerHash?: string): Promise<MPTokenIssuance>;
    validateConfiguration(): Promise<void>;
    private holder;
    state(address: string, ledgerHash?: string): Promise<HolderState>;
    private banKey;
    banStatus(address: string): Promise<Ban | undefined>;
    private notBanned;
    private send;
    private authTx;
    private lockTx;
    approve(address: string, id: string): Promise<void>;
    mint(address: string, value: string, id: string): Promise<void>;
    clawback(address: string, value: string, id: string): Promise<void>;
    freezeHolder(address: string, frozen: boolean, id: string): Promise<void>;
    freezeGlobal(frozen: boolean, id: string): Promise<void>;
    /** Resumable saga: intent -> revoke -> lock -> drain -> verify. Never auto-unban. */
    ban(address: string, reason: string, id: string): Promise<void>;
}
