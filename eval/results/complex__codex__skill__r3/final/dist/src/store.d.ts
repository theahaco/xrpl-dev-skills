/** Must be durable before resolving. Use a transactional database with multiple workers. */
export interface Store {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
}
/** Single-process adapter. Enforce one writer per issuer and store. */
export declare class FileStore implements Store {
    private readonly path;
    private readonly data;
    private constructor();
    static open(path: string): Promise<FileStore>;
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
}
export declare class SerialQueue {
    private tail;
    run<T>(fn: () => Promise<T>): Promise<T>;
}
