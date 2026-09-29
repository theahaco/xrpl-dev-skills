import { type ComplianceStore, type Operation } from './issuer.js';
export declare function atomicJson(path: string, value: unknown): Promise<void>;
/** Single-process adapter. Keep on durable disk; use a transactional database in a backend cluster. */
export declare class FileStore implements ComplianceStore {
    private readonly path;
    private state;
    private readonly mutex;
    private constructor();
    static load(path: string): Promise<FileStore>;
    getOperation(key: string): Promise<Operation | undefined>;
    pendingOperation(): Promise<string | undefined>;
    putOperation(key: string, value: Operation): Promise<void>;
    isBanned(id: string, holder: string): Promise<boolean>;
    markBanned(id: string, holder: string): Promise<void>;
}
