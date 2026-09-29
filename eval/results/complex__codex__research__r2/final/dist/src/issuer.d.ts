import { Client, type SubmittableTransaction, type Wallet, type LedgerEntry } from 'xrpl';
type MPToken = LedgerEntry.MPToken;
type MPTokenIssuance = LedgerEntry.MPTokenIssuance;
import type { Store, Receipt } from './store.js';
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export declare const MAX_AMOUNT = "9223372036854775807";
export declare const CAPABILITIES: number;
export declare const REQUIRED_AMENDMENTS: {
    MPTokensV1: string;
    Clawback: string;
};
export declare function amount(value: string): string;
export declare function issuanceId(value: string): string;
export declare function address(value: string): string;
export interface Signer {
    address: string;
    sign(tx: SubmittableTransaction): Promise<{
        tx_blob: string;
        hash: string;
    }>;
}
export declare function walletSigner(wallet: Wallet): Signer;
export declare class LedgerFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
/** One runner for ALL transactions from the issuer account; no parallel external signers.
 * Signed transactions are persisted before broadcast. Reusing an operation ID resumes
 * the identical signed transaction, never a fresh payment/clawback.
 */
export declare class TransactionRunner {
    readonly client: Client;
    readonly store: Store;
    private tail;
    private uncertain;
    constructor(client: Client, store: Store);
    checkNetwork(): Promise<void>;
    exclusive<T>(fn: () => Promise<T>): Promise<T>;
    submit(key: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt>;
    private record;
    private success;
}
export declare class MptIssuer {
    readonly runner: TransactionRunner;
    readonly signer: Signer;
    readonly id: string;
    constructor(runner: TransactionRunner, signer: Signer, id: string);
    static create(runner: TransactionRunner, signer: Signer, operationId: string): Promise<MptIssuer>;
    issuance(ledger?: number | 'validated'): Promise<MPTokenIssuance>;
    holder(holder: string, ledger?: number | 'validated'): Promise<MPToken | undefined>;
    assertConfiguration(): Promise<void>;
    private banKey;
    private checkHolder;
    approve(key: string, holder: string): Promise<Receipt>;
    issue(key: string, holder: string, value: string): Promise<Receipt>;
    clawback(key: string, holder: string, value: string): Promise<Receipt>;
    /** Native MPT lock: issuer redemption and clawback are protocol exceptions. */
    freeze(key: string, holder: string, frozen: boolean): Promise<Receipt>;
    /** Native global lock; does not override the protocol's issuer-redemption exception. */
    globalFreeze(key: string, frozen: boolean): Promise<Receipt>;
    private setLock;
    /** Retry the SAME key after an interruption. Persist intent before any ledger effects.
     * No rollback to approval on error. A ban is complete only after the final ledger check.
     */
    ban(key: string, holder: string, reason: string): Promise<void>;
}
export {};
