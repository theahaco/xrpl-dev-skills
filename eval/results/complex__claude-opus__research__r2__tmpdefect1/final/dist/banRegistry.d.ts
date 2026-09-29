export interface BanRecord {
    address: string;
    reason: string;
    bannedAt: string;
}
/**
 * Durable record of banned addresses.
 *
 * The ledger can revoke a holder's authorization, but it can't stop the issuer from
 * authorizing that holder again later. A holder can also delete their zero-balance
 * MPToken entry and create a fresh one, which drops the lock flag. The registry is
 * therefore the source of truth for bans. In production, back it with your database.
 */
export interface BanRegistry {
    isBanned(address: string): Promise<boolean>;
    get(address: string): Promise<BanRecord | undefined>;
    /** Must be durable before it resolves; a ban is recorded before any ledger action. */
    add(record: BanRecord): Promise<void>;
    list(): Promise<BanRecord[]>;
}
export declare class InMemoryBanRegistry implements BanRegistry {
    #private;
    isBanned(address: string): Promise<boolean>;
    get(address: string): Promise<BanRecord | undefined>;
    add(record: BanRecord): Promise<void>;
    list(): Promise<BanRecord[]>;
}
/**
 * JSON-file registry for single-process deployments and demos. Writes go to a
 * temporary file that is then renamed into place, so a crash can't leave a
 * half-written file.
 */
export declare class JsonFileBanRegistry implements BanRegistry {
    #private;
    readonly path: string;
    constructor(path: string);
    isBanned(address: string): Promise<boolean>;
    get(address: string): Promise<BanRecord | undefined>;
    add(record: BanRecord): Promise<void>;
    list(): Promise<BanRecord[]>;
}
