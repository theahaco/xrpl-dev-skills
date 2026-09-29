/** Durable storage, held exclusively for the entire service lifetime. */
export interface Store {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
}
export declare function errorCode(error: unknown): string | undefined;
export declare function atomicJson(path: string, value: unknown): Promise<void>;
/** Single-host reference adapter. A stale lock requires operator reconciliation, never auto-removal. */
export declare class FileStore implements Store {
    private readonly path;
    private readonly values;
    private constructor();
    static open(path: string): Promise<FileStore>;
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    close(): Promise<void>;
}
