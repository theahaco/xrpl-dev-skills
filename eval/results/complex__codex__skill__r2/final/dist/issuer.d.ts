import { Client, Wallet, type SubmittableTransaction as Transaction, type TransactionMetadata } from 'xrpl';
export interface MPToken {
    LedgerEntryType: 'MPToken';
    MPTAmount: string;
    Flags: number;
}
export interface MPTokenIssuance {
    LedgerEntryType: 'MPTokenIssuance';
    Issuer: string;
    Flags: number;
    AssetScale?: number;
    OutstandingAmount: string;
}
export declare const TESTNET = "wss://s.altnet.rippletest.net:51233";
export declare const CAPABILITIES: number;
export declare const MAX_AMOUNT: string;
export declare function amount(value: string): string;
export declare function holderAddress(value: string, issuer: string): string;
export declare function issuanceId(value: string): string;
export interface Receipt {
    hash: string;
    ledgerIndex: number;
    code: string;
    meta: TransactionMetadata;
}
export interface Pending {
    intent: string;
    blob: string;
    hash: string;
    lastLedger: number;
}
export interface Operation extends Pending {
    receipt?: Receipt;
}
/** Persist before returning. Production implementations must use durable transactions. */
export interface ComplianceStore {
    getOperation(key: string): Promise<Operation | undefined>;
    putOperation(key: string, value: Operation): Promise<void>;
    pendingOperation(): Promise<string | undefined>;
    isBanned(issuance: string, holder: string): Promise<boolean>;
    markBanned(issuance: string, holder: string): Promise<void>;
}
export interface Signer {
    address: string;
    sign(transaction: Transaction): Promise<{
        tx_blob: string;
        hash: string;
    }>;
}
export declare function walletSigner(wallet: Wallet): Signer;
export declare class LedgerFailure extends Error {
    readonly receipt: Receipt;
    constructor(receipt: Receipt);
}
export declare class UncertainSubmission extends Error {
    readonly operation: string;
    readonly hash: string;
    constructor(operation: string, hash: string, options?: ErrorOptions);
}
export declare class Mutex {
    private tail;
    run<T>(fn: () => Promise<T>): Promise<T>;
}
/** One executor per signing account/work queue. No other process may use its sequences. */
export declare class TransactionExecutor {
    readonly client: Client;
    readonly store: ComplianceStore;
    private readonly mutex;
    constructor(client: Client, store: ComplianceStore);
    assertTestnet(): Promise<void>;
    execute(key: string, tx: Transaction, signer: Signer): Promise<Receipt>;
    private success;
}
/** Backend API. KYC approval is the caller's responsibility; no PII goes on-ledger. */
export declare class MptIssuer {
    readonly executor: TransactionExecutor;
    private readonly signer;
    readonly id: string;
    private readonly mutex;
    constructor(executor: TransactionExecutor, signer: Signer, id: string);
    static create(executor: TransactionExecutor, signer: Signer, key: string): Promise<MptIssuer>;
    issuance(ledger?: number | 'validated'): Promise<MPTokenIssuance>;
    holder(address: string, ledger?: number | 'validated'): Promise<MPToken | undefined>;
    assertCapabilities(): Promise<void>;
    private allowed;
    private send;
    approve(address: string, key: string): Promise<Receipt>;
    mint(address: string, value: string, key: string): Promise<Receipt>;
    clawback(address: string, value: string, key: string): Promise<Receipt>;
    private clawbackInternal;
    setFrozen(address: string, frozen: boolean, key: string): Promise<Receipt>;
    setGlobalFrozen(frozen: boolean, key: string): Promise<Receipt>;
    private lock;
    /** Resumable, fail-closed workflow; not an atomic ledger transaction. Repeat with the SAME key. */
    ban(address: string, key: string): Promise<void>;
}
