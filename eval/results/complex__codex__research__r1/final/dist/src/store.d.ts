export interface Receipt {
    hash: string;
    ledgerIndex: number;
    code: string;
    issuanceId?: string;
}
export interface PendingTransaction {
    intent: string;
    blob: string;
    hash: string;
    lastLedgerSequence: number;
    receipt?: Receipt;
}
export interface State {
    version: 1;
    network: 'testnet';
    issuer: string;
    transactions: Record<string, PendingTransaction>;
    bans: Record<string, {
        reason: string;
        requestedAt: string;
        completed: boolean;
    }>;
    steps: Record<string, boolean>;
    issuanceId?: string;
}
/** Single-writer, fsync-backed local adapter. Keep this directory on a local durable disk.
 * A multi-host deployment must substitute a transactional database and distributed lock.
 * Never automatically remove a stale lock: first establish the old worker is dead.
 */
export declare class FileStore {
    readonly directory: string;
    readonly state: State;
    private readonly lock;
    private closed;
    constructor(directory: string, issuer: string);
    save(): void;
    close(): void;
}
export declare function atomicJson(path: string, value: unknown): void;
