export interface BanRecord {
    issuanceId: string;
    address: string;
    reason: string;
    bannedAt: string;
}
/**
 * Durable record of banned addresses. The ledger enforces a ban by leaving the
 * holder unauthorized; this registry makes sure the issuer never re-approves
 * them. Production deployments should back this with the compliance database.
 */
export interface BanRegistry {
    isBanned(issuanceId: string, address: string): Promise<boolean>;
    get(issuanceId: string, address: string): Promise<BanRecord | undefined>;
    /** Must be durable before it resolves: the ban is recorded before any ledger action. */
    record(ban: BanRecord): Promise<void>;
}
export declare class InMemoryBanRegistry implements BanRegistry {
    private readonly bans;
    isBanned(issuanceId: string, address: string): Promise<boolean>;
    get(issuanceId: string, address: string): Promise<BanRecord | undefined>;
    record(ban: BanRecord): Promise<void>;
}
/**
 * JSON-file registry for single-process deployments and demos. Writes are
 * atomic (write to a temp file, then rename) and serialized within the process.
 */
export declare class FileBanRegistry implements BanRegistry {
    private readonly path;
    private writeChain;
    constructor(path: string);
    isBanned(issuanceId: string, address: string): Promise<boolean>;
    get(issuanceId: string, address: string): Promise<BanRecord | undefined>;
    record(ban: BanRecord): Promise<void>;
    private readAll;
}
