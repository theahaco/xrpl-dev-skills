import { DatabaseSync } from 'node:sqlite';
import type { BanStore, Journal, Prepared, Receipt } from './issuer.js';
/** Local durable adapter. Deploy on persistent disk, one issuer worker per database. */
export declare class SqliteStore implements BanStore, Journal {
    readonly db: DatabaseSync;
    constructor(path: string);
    assertNoPending(): void;
    has(id: string, holder: string): Promise<boolean>;
    add(id: string, holder: string): Promise<void>;
    prepared(record: Prepared): Promise<void>;
    validated(receipt: Receipt): Promise<void>;
    get<T>(key: string): T | undefined;
    put(key: string, value: unknown): void;
    receipts(): unknown[];
    close(): void;
}
