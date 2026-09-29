export interface Receipt {
    hash: string;
    ledgerIndex: number;
    code: string;
    issuanceId?: string;
}
export interface JournalEntry {
    fingerprint: string;
    blob: string;
    hash: string;
    lastLedgerSequence: number;
    receipt?: Receipt;
}
export interface State {
    version: 1;
    transactions: Record<string, JournalEntry>;
    bans: Record<string, {
        reason: string;
        requestedAt: string;
    }>;
}
/** Single-writer durable store. Keep the lock for the entire service lifetime.
 * Production deployments can replace this with a transactional database adapter.
 */
export interface Store {
    readonly state: State;
    save(): Promise<void>;
}
export declare function atomicJson(path: string, data: unknown): Promise<void>;
export declare class FileStore implements Store {
    readonly path: string;
    readonly state: State;
    private readonly release;
    private constructor();
    static open(path: string): Promise<FileStore>;
    save(): Promise<void>;
    close(): Promise<void>;
}
