export interface Receipt {
    hash: string;
    code: string;
    ledger: number;
    issuanceId?: string;
}
export interface Pending {
    key: string;
    account: string;
    intent: string;
    blob: string;
    hash: string;
    receipt: string | null;
}
/** Durable single-writer journal. Keep this directory on persistent local storage. */
export declare class Store {
    private readonly db;
    private readonly lock;
    constructor(path: string);
    get(key: string): Pending | undefined;
    pending(account: string): Pending | undefined;
    prepare(row: Omit<Pending, 'receipt'>): void;
    complete(key: string, receipt: Receipt): void;
    ban(issuance: string, holder: string, reason: string): void;
    isBanned(issuance: string, holder: string): boolean;
    checkpoint(name: string): void;
    hasCheckpoint(name: string): boolean;
    receipts(): (Receipt & {
        operationKey: string;
    })[];
    close(): void;
}
