/**
 * Durable record of banned addresses.
 *
 * The XRP Ledger has no "banned" flag for MPT holders. A ban is enforced on
 * ledger by revoking the holder's authorization (the issuance requires auth),
 * locking their MPToken and clawing back their balance. But the holder can
 * delete their emptied MPToken and create a fresh one, which erases the lock.
 * The fresh MPToken is still unauthorized, so they still can't receive the
 * token. What keeps them out for good is that the issuer never authorizes
 * them again. This registry is the source of truth for that rule.
 *
 * Production deployments should back this with the compliance database.
 */
export interface BanRecord {
    address: string;
    reason: string;
    bannedAt: string;
}
export interface BanRegistry {
    isBanned(address: string): Promise<boolean>;
    get(address: string): Promise<BanRecord | undefined>;
    /** Records a ban. Must be durable before it resolves. Idempotent: an existing record is kept. */
    add(record: BanRecord): Promise<void>;
    list(): Promise<BanRecord[]>;
}
export declare class InMemoryBanRegistry implements BanRegistry {
    private readonly records;
    isBanned(address: string): Promise<boolean>;
    get(address: string): Promise<BanRecord | undefined>;
    add(record: BanRecord): Promise<void>;
    list(): Promise<BanRecord[]>;
}
/**
 * JSON-file-backed registry. Writes go to a temp file and are then renamed
 * over the original, so a crash never leaves a half-written file. Meant for
 * one process only; there is no cross-process locking.
 */
export declare class JsonFileBanRegistry implements BanRegistry {
    private readonly filePath;
    private cache;
    private writeChain;
    constructor(filePath: string);
    isBanned(address: string): Promise<boolean>;
    get(address: string): Promise<BanRecord | undefined>;
    list(): Promise<BanRecord[]>;
    add(record: BanRecord): Promise<void>;
    private load;
    private persist;
}
