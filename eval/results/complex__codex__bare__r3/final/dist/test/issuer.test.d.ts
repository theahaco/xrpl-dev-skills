import type { Store } from '../src/store.js';
export declare class MemoryStore implements Store {
    readonly values: Map<string, unknown>;
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
}
