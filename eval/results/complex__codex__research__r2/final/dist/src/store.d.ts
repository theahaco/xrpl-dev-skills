export interface Receipt {
    hash: string;
    ledger: number;
    code: string;
    sequence: number;
}
export interface Pending {
    intent: string;
    blob: string;
    hash: string;
    sequence: number;
    lastLedger: number;
    receipt: string | null;
}
/** One durable store and exclusive process per issuer. Never remove a live lock. */
export declare class Store {
    private readonly db;
    private readonly lock;
    constructor(path: string);
    getTx(id: string): Pending | undefined;
    pendingId(): string | undefined;
    prepare(id: string, p: Omit<Pending, 'receipt'>): void;
    finish(id: string, r: Receipt): void;
    ban(issuance: string, holder: string, reason: string): void;
    isBanned(issuance: string, holder: string): boolean;
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    audit(): unknown[];
    close(): void;
}
