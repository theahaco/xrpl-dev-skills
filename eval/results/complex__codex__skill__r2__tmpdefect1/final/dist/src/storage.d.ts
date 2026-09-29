import type { BanStore, Journal, PreparedRecord, Receipt } from './issuer.js';
/** Append-only, fsync'd store for ONE process. Backends should supply database adapters. */
export declare class FileStore implements BanStore, Journal {
    readonly path: string;
    constructor(path: string);
    append(event: object): Promise<void>;
    events(): Promise<Record<string, unknown>[]>;
    assertReady(account: string): Promise<void>;
    prepared(record: PreparedRecord): Promise<void>;
    settled(receipt: Receipt): Promise<void>;
    isBanned(issuanceId: string, holder: string): Promise<boolean>;
    ban(issuanceId: string, holder: string): Promise<void>;
}
