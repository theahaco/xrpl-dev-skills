/** Atomic replacement plus fsync. Never store seeds in this store. */
export declare function saveJson(path: string, value: unknown): void;
export declare function readJson<T>(path: string, initial: T): T;
/** Exclusive writer for the store's entire lifetime. Crashes leave a lock for operator review. */
export declare function acquireLock(path: string): () => void;
