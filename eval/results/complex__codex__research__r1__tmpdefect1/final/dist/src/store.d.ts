export declare function atomicJson(path: string, value: unknown): void;
/** Single-writer durable JSON storage. Use one directory for every operation on an issuer.
 * A stale lock requires operator reconciliation; it is never silently stolen. */
export declare class FileStore {
    readonly directory: string;
    private readonly lock;
    private closed;
    constructor(directory: string);
    read<T>(name: string): T | undefined;
    write(name: string, value: unknown): void;
    private path;
    close(): void;
}
export declare class SerialQueue {
    private tail;
    run<T>(work: () => Promise<T>): Promise<T>;
}
