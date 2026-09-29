/** Exclusive single-writer store. Remove a stale lock only after stopping its owner. */
export declare class Store {
    readonly path: string;
    private readonly db;
    private readonly lock;
    constructor(path: string);
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    atomic(action: () => void): void;
    close(): void;
}
