import { type Client, type Payment } from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { Store } from './store.js';
import { TransactionRunner, type Signer } from './transactions.js';
export declare const MAX_MPT = "9223372036854775807";
export declare const ISSUANCE_FLAGS: number;
export declare function amount(value: string): string;
export declare function address(value: string): string;
export declare function issuanceId(value: string): string;
export declare function payment(account: string, destination: string, id: string, value: string): Payment;
export declare function readIssuance(client: Client, id: string, ledger?: number | 'validated'): Promise<MPTokenIssuance>;
export declare function readHolder(client: Client, id: string, holder: string, ledger?: number | 'validated'): Promise<MPToken | undefined>;
export interface KycApproval {
    reference: string;
    approvedBy: string;
}
/** Issuer-only service. Native MPT locks allow issuer interactions; see README. */
export declare class MptIssuer {
    readonly id: string;
    private readonly signer;
    private readonly runner;
    private readonly store;
    private control;
    private constructor();
    static create(signer: Signer, runner: TransactionRunner, store: Store, operationId: string): Promise<MptIssuer>;
    static open(id: string, signer: Signer, runner: TransactionRunner, store: Store): Promise<MptIssuer>;
    private holder;
    private banKey;
    private assertNotBanned;
    approve(holder: string, kyc: KycApproval, operationId: string): Promise<import("./transactions.js").Receipt>;
    issue(holder: string, value: string, operationId: string): Promise<import("./transactions.js").Receipt>;
    clawback(holder: string, value: string, operationId: string): Promise<import("./transactions.js").Receipt>;
    freezeHolder(holder: string, frozen: boolean, operationId: string): Promise<import("./transactions.js").Receipt>;
    freezeGlobal(frozen: boolean, operationId: string): Promise<import("./transactions.js").Receipt>;
    /** Durable tombstone first; revoke then drain. Retry the SAME ban ID until complete. */
    ban(holder: string, reason: string, operationId: string): Promise<void>;
    private authorize;
    private lock;
    private claw;
}
