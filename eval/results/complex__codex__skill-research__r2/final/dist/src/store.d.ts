/** Single writer, durable local store. Keep the DB and journal with the issuer service. */
export declare class Store {
    private readonly db;
    private readonly lock;
    constructor(path: string);
    get<T>(key: string): T | undefined;
    put(key: string, value: unknown): void;
    putMany(entries: readonly (readonly [string, unknown])[]): void;
    entries<T>(prefix: string): {
        key: string;
        value: T;
    }[];
    close(): void;
}
export declare class SerialQueue {
    private tail;
    run<T>(work: () => Promise<T>): Promise<T>;
}
