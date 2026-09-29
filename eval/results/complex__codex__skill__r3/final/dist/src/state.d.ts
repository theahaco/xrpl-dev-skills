import type { TransactionMetadata } from 'xrpl';
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
    receipt?: Receipt;
}
export interface StateData {
    version: 1;
    transactions: Record<string, Pending>;
    bans: Record<string, {
        reason: string;
        startedAt: string;
        complete: boolean;
    }>;
    demoSalt?: string;
}
/** Backend adapters must provide durable writes and exclusive ownership for the entire issuer workflow. */
export interface StateStore {
    data: StateData;
    save(): Promise<void>;
}
/** Single-host, single-writer store. A stale lock requires operator reconciliation, never automatic deletion. */
export declare class FileState implements StateStore {
    readonly directory: string;
    data: StateData;
    private constructor();
    static open(directory: string): Promise<FileState>;
    private readonly writes;
    save(): Promise<void>;
    private flush;
    close(): Promise<void>;
}
export declare class SerialQueue {
    private tail;
    run<T>(operation: () => Promise<T>): Promise<T>;
}
