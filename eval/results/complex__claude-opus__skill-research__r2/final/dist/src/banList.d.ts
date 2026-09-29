export interface BanRecord {
    address: string;
    reason: string;
    /** ISO-8601 timestamp of when the ban was recorded. */
    bannedAt: string;
}
/**
 * Durable record of banned addresses, owned by the backend.
 *
 * The ledger enforces a ban by revoking the holder's authorization, but
 * nothing on the ledger stops the issuer from authorizing that address again
 * later. On testnet (without the fixCleanup3_4_0 amendment) the holder can
 * also delete their locked, empty MPToken entry, which removes any on-ledger
 * trace of the ban. This list is therefore the source of truth: the issuer
 * module consults it before approving or issuing to anyone.
 *
 * Production deployments should back this with the compliance database.
 */
export interface BanList {
    isBanned(address: string): Promise<boolean>;
    get(address: string): Promise<BanRecord | undefined>;
    /** Idempotent: re-adding an existing address keeps the original record. */
    add(record: BanRecord): Promise<void>;
    list(): Promise<BanRecord[]>;
}
export declare class InMemoryBanList implements BanList {
    #private;
    isBanned(address: string): Promise<boolean>;
    get(address: string): Promise<BanRecord | undefined>;
    add(record: BanRecord): Promise<void>;
    list(): Promise<BanRecord[]>;
}
/**
 * Ban list persisted as a JSON file. Writes go to a temp file and are then
 * renamed into place, so a crash never leaves a truncated file. Suitable for
 * a single process; use a database-backed implementation for multiple
 * backend instances.
 */
export declare class JsonFileBanList implements BanList {
    #private;
    readonly path: string;
    constructor(path: string);
    isBanned(address: string): Promise<boolean>;
    get(address: string): Promise<BanRecord | undefined>;
    add(record: BanRecord): Promise<void>;
    list(): Promise<BanRecord[]>;
}
