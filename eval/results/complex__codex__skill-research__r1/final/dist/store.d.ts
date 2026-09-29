/** One process owns this durable journal. Never remove a lock while its owner is alive. */
export declare class Store {
    private readonly db;
    private readonly lock;
    constructor(path: string);
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    entries<T>(prefix: string): [string, T][];
    close(): void;
}
export declare class Serial {
    private tail;
    run<T>(fn: () => Promise<T>): Promise<T>;
}
