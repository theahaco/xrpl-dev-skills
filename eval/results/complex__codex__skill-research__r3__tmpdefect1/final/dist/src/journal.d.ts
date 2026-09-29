import { DatabaseSync } from 'node:sqlite';
/** Durable single-writer store. Route ALL issuer signing through this writer. */
export declare class Journal {
    readonly db: DatabaseSync;
    private readonly lock;
    constructor(path: string);
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    banned(issuance: string, holder: string): boolean;
    ban(issuance: string, holder: string, reason: string): void;
    close(): void;
}
