import { Client, type MPTokenIssuanceCreate, type Payment } from 'xrpl';
import { type Store } from './store.js';
import type { Submitter, Receipt } from './transactions.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
export declare const MAX_AMOUNT = "9223372036854775807";
export declare const ISSUANCE_FLAGS: number;
export declare function amount(value: string): string;
export declare function address(value: string): string;
export declare function issuanceId(value: string): string;
export declare function createIssuanceTx(issuer: string, maximumAmount: string): MPTokenIssuanceCreate;
export declare function paymentTx(id: string, from: string, to: string, value: string): Payment;
export interface LedgerReader {
    issuance(id: string, ledger?: number): Promise<MPTokenIssuance>;
    holding(id: string, holder: string, ledger?: number): Promise<MPToken | undefined>;
}
export declare class XrplLedgerReader implements LedgerReader {
    private readonly client;
    constructor(client: Client);
    issuance(id: string, ledger?: number): Promise<MPTokenIssuance>;
    holding(id: string, holder: string, ledger?: number): Promise<MPToken | undefined>;
}
/** Native MPT locks exempt payments involving the issuer. They are NOT an absolute movement halt. */
export declare class MptIssuer {
    readonly id: string;
    private readonly runner;
    private readonly ledger;
    private readonly store;
    private readonly queue;
    constructor(id: string, runner: Submitter, ledger: LedgerReader, store: Store);
    static create(runner: Submitter, ledger: LedgerReader, store: Store, key: string, maximumAmount?: string): Promise<MptIssuer>;
    checkCapabilities(): Promise<void>;
    private holder;
    private banKey;
    private assertNotBanned;
    approve(holder: string, key: string): Promise<Receipt>;
    mint(holder: string, value: string, key: string): Promise<Receipt>;
    clawback(holder: string, value: string, key: string): Promise<Receipt>;
    private clawbackTx;
    freezeHolder(holder: string, key: string): Promise<Receipt>;
    unfreezeHolder(holder: string, key: string): Promise<Receipt>;
    freezeGlobal(key: string): Promise<Receipt>;
    unfreezeGlobal(key: string): Promise<Receipt>;
    private lock;
    private lockTx;
    /** Resumable saga: durable ban -> revoke permission -> lock -> drain -> verify.
     * Revocation validates BEFORE draining so new receipts cannot race the drain.
     * Pending bans block approval/unlock/mint even after a crash. No unban API.
     */
    ban(holder: string, key: string, reason: string): Promise<void>;
}
