import { type LedgerPort, type Receipt } from './ledger.js';
import type { BanStore } from './storage.js';
export declare const MAX_AMOUNT: string;
export declare const REQUIRED_FLAGS: number;
export declare const LOCKED = 1;
export declare const AUTHORIZED = 2;
export declare function amount(value: string): string;
export declare function address(value: string): string;
/** Scale zero: all amounts are whole token units, represented as strings. */
export declare class MptIssuer {
    readonly account: string;
    readonly issuanceId: string;
    private readonly ledger;
    private readonly bans;
    private tail;
    constructor(account: string, issuanceId: string, ledger: LedgerPort, bans: BanStore);
    static create(account: string, ledger: LedgerPort, bans: BanStore, key: string): Promise<MptIssuer>;
    /** Reject incompatible assets, including escrow/trading/confidential capabilities. */
    validate(): Promise<void>;
    private holder;
    private run;
    private allowed;
    private tx;
    /** Call only after backend KYC approval. Holder must first opt in using MPTokenAuthorize. */
    approve(holder: string, key: string): Promise<Receipt>;
    mint(holder: string, quantity: string, key: string): Promise<Receipt>;
    clawback(holder: string, quantity: string, key: string): Promise<Receipt>;
    private claw;
    private lock;
    freeze(holder: string, key: string): Promise<Receipt>;
    unfreeze(holder: string, key: string): Promise<Receipt>;
    globalFreeze(key: string): Promise<Receipt>;
    globalUnfreeze(key: string): Promise<Receipt>;
    /** Resumable saga, not atomic: persist ban, revoke authorization, drain, verify.
     * Revocation closes the inbound race. Holder redemption can only reduce the drain.
     * A ban on an account without an MPToken entry still prevents future module approval.
     */
    ban(holder: string, key: string): Promise<void>;
}
