/** Implement with a transactional database and an issuer-wide worker lease in a distributed backend. */
export interface Store {
    get<T>(key: string): T | undefined;
    put<T>(key: string, value: T): void;
}
/** Single-process durable store; the caller must hold an exclusive process lock. */
export declare class FileStore implements Store {
    private readonly path;
    private data;
    constructor(path: string);
    get<T>(key: string): T | undefined;
    /** Audit export intentionally excludes signed blobs and wallet secrets. */
    receipts(): Record<string, unknown>;
    put<T>(key: string, value: T): void;
}
