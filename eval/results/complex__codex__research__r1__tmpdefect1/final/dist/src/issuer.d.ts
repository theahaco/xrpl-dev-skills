import { type Client, type Payment } from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { FileStore } from './store.js';
import { TransactionRunner, type Signer } from './ledger.js';
export declare const MAX_AMOUNT = 9223372036854775807n;
export declare const CAPABILITIES: number;
export declare function amount(value: string): string;
export declare function issuanceId(value: string): string;
export interface Snapshot {
    ledgerHash: string;
    ledgerIndex: number;
    issuance: MPTokenIssuance;
    holders: Record<string, MPToken | null>;
}
export declare function snapshot(client: Client, id: string, holders: readonly string[]): Promise<Snapshot>;
/** All amounts are base-unit integer strings. This profile uses AssetScale=0.
 * Native locks exempt payments involving the issuer. This module blocks issuance
 * while locked, but holders can still return value directly to the issuer.
 * One instance, runner and locked store must own all writes for this issuer. */
export declare class MptIssuer {
    readonly id: string;
    private readonly runner;
    private readonly signer;
    private readonly store;
    private readonly queue;
    private readonly policy;
    private constructor();
    static create(runner: TransactionRunner, signer: Signer, store: FileStore, key: string): Promise<MptIssuer>;
    static open(id: string, runner: TransactionRunner, signer: Signer, store: FileStore): Promise<MptIssuer>;
    inspect(holders: readonly string[]): Promise<Snapshot>;
    private holder;
    private allowed;
    private save;
    isBanned(holder: string): boolean;
    /** Holder signs this separately, without sharing a seed with the issuer backend. */
    enrollment(holder: string): {
        TransactionType: 'MPTokenAuthorize';
        Account: string;
        MPTokenIssuanceID: string;
    };
    approve(holder: string, key: string): Promise<void>;
    issue(holder: string, value: string, key: string): Promise<void>;
    payment(from: string, to: string, value: string): Payment;
    /** Claws back up to value, capped by the available balance by ledger semantics. */
    clawback(holder: string, value: string, key: string): Promise<void>;
    freezeHolder(holder: string, frozen: boolean, key: string): Promise<void>;
    freezeAll(frozen: boolean, key: string): Promise<void>;
    private lock;
    /** Durable, resumable multi-transaction ban; never reports completion before verification.
     * Revocation first prevents new receipts even if a zero-balance holder deletes/recreates
     * its MPToken. Clawback ignores auth/locks. Escrow/trading/confidential balances are disabled. */
    ban(holder: string, reason: string): Promise<void>;
}
