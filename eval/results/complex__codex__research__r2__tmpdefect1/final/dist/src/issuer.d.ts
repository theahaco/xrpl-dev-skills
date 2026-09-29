import { Client, Wallet } from 'xrpl';
import type { LedgerEntry } from 'xrpl';
import { Submitter } from './submitter.js';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export declare const MAX_AMOUNT: string;
export declare const CAPABILITIES: number;
type MPTokenIssuance = LedgerEntry.MPTokenIssuance;
export interface HolderState {
    LedgerEntryType: 'MPToken';
    Account: string;
    MPTokenIssuanceID: string;
    Flags: number;
    MPTAmount: string;
}
export declare function amount(value: string): string;
export declare function issuanceID(sequence: number, issuer: string): string;
export declare function assertTestnet(client: Client): Promise<unknown>;
/** Dedicated issuer: no deposit preauthorizations, escrow, trading or confidential balances.
 * All mutating methods serialize across the shared Submitter. Backend performs KYC before approve.
 */
export declare class MptIssuer {
    readonly submitter: Submitter;
    private readonly wallet;
    readonly id: string;
    constructor(submitter: Submitter, wallet: Wallet, id: string);
    get address(): string;
    private get client();
    private holderAddress;
    private notBanned;
    static create(submitter: Submitter, wallet: Wallet, operationId: string): Promise<MptIssuer>;
    issuance(ledger?: number | 'validated'): Promise<MPTokenIssuance>;
    holder(holder: string, ledger?: number | 'validated'): Promise<HolderState | undefined>;
    assertConfiguration(): Promise<void>;
    approve(holder: string, operationId: string): Promise<void>;
    issue(holder: string, value: string, operationId: string): Promise<void>;
    clawback(holder: string, value: string, operationId: string): Promise<void>;
    freezeHolder(holder: string, frozen: boolean, operationId: string): Promise<void>;
    freezeGlobal(frozen: boolean, operationId: string): Promise<void>;
    private lock;
    /** Durable intent first; lock -> revoke -> drain -> verify. Retry with the SAME operation ID.
     * Not atomic. Failures leave the ban intent in force; never automatically restore authorization.
     */
    ban(holder: string, reason: string, operationId: string): Promise<void>;
}
export {};
