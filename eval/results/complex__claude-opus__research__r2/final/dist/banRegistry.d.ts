/**
 * Durable record of banned holder addresses.
 *
 * The ledger itself cannot durably remember a ban:
 *  - Under Require Auth, a holder can only receive the token while the issuer
 *    has authorized their MPToken entry. Banning revokes that authorization,
 *    and it stays revoked only as long as the issuer never re-authorizes.
 *  - Once a banned holder's balance is zero, they can delete their MPToken
 *    entry (on testnet this is possible even while it is locked, because the
 *    fixCleanup3_4_0 amendment is not enabled). A new MPToken entry starts out
 *    unauthorized, so the address still cannot receive tokens. But no on-ledger
 *    trace of the ban remains.
 *
 * So the issuer's backend must remember bans and refuse to authorize those
 * addresses again. In production, back this with your system of record (a
 * database table with an audit trail). The file-based implementation below is
 * suitable for the demo and for single-process deployments.
 */
export interface BanRecord {
    address: string;
    bannedAt: string;
    reason?: string;
}
export interface BanRegistry {
    isBanned(address: string): Promise<boolean>;
    /** Record a ban. Must be durable before it resolves. Idempotent. */
    add(record: BanRecord): Promise<void>;
    get(address: string): Promise<BanRecord | undefined>;
    list(): Promise<BanRecord[]>;
}
export declare class InMemoryBanRegistry implements BanRegistry {
    private readonly records;
    isBanned(address: string): Promise<boolean>;
    add(record: BanRecord): Promise<void>;
    get(address: string): Promise<BanRecord | undefined>;
    list(): Promise<BanRecord[]>;
}
/**
 * JSON-file-backed registry. Writes are atomic (write a temp file, then rename)
 * and serialized within the process. Not safe for several processes writing
 * the same file.
 */
export declare class FileBanRegistry implements BanRegistry {
    private readonly path;
    private writeChain;
    constructor(path: string);
    isBanned(address: string): Promise<boolean>;
    get(address: string): Promise<BanRecord | undefined>;
    list(): Promise<BanRecord[]>;
    add(record: BanRecord): Promise<void>;
    private read;
    private write;
}
