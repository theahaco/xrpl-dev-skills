import { LedgerEntry, type AccountObject, type Payment } from 'xrpl';
import { Runner, type Signer } from './runtime.js';
type MPToken = LedgerEntry.MPToken;
type MPTokenIssuance = LedgerEntry.MPTokenIssuance;
type ObjectEntry = AccountObject | MPToken;
export declare const MAX_AMOUNT: string;
export declare const CAPABILITIES: number;
export declare function amount(value: string): string;
export declare function holderAddress(holder: string, issuer: string): string;
export declare function objects(runner: Runner, account: string, ledger?: number | 'validated'): Promise<ObjectEntry[]>;
/** All mutating calls require stable business-operation IDs. Amounts are atomic units. */
export declare class MptIssuer {
    readonly runner: Runner;
    readonly signer: Signer;
    readonly issuanceId: string;
    private readonly serial;
    constructor(runner: Runner, signer: Signer, issuanceId: string);
    static create(runner: Runner, signer: Signer, key: string): Promise<MptIssuer>;
    issuance(ledger?: number | 'validated'): Promise<MPTokenIssuance>;
    holder(holder: string, ledger?: number | 'validated'): Promise<MPToken | undefined>;
    assertConfiguration(): Promise<void>;
    private allowed;
    approve(holder: string, key: string): Promise<void>;
    payment(from: string, to: string, value: string): Payment;
    issue(holder: string, value: string, key: string): Promise<void>;
    freeze(holder: string, frozen: boolean, key: string): Promise<void>;
    private lock;
    globalFreeze(frozen: boolean, key: string): Promise<void>;
    clawback(holder: string, value: string, key: string): Promise<void>;
    private reclaim;
    /** Durable, fail-closed saga: persist ban, lock, revoke authorization, drain, verify.
     * Re-run with the same key after interruption. Never unlock a partially banned holder.
     */
    ban(holder: string, reason: string, key: string): Promise<void>;
}
export {};
