/** Durable single-writer store. Keep this database across deployments and retries. */
export declare class Store {
    private readonly db;
    private readonly lock;
    constructor(path: string);
    get<T>(key: string): T | undefined;
    put(key: string, value: unknown): void;
    entries(prefix: string): Array<{
        key: string;
        value: unknown;
    }>;
    atomic(fn: () => void): void;
    close(): void;
}
