import type { BanStore, Journal, Receipt } from './issuer.js';
/** Local single-process adapter. Backend deployments should use a transactional database. */
export declare class FileStore implements BanStore, Journal {
    readonly directory: string;
    constructor(directory: string);
    private append;
    records(file: string): Promise<Record<string, unknown>[]>;
    assertNoPending(): Promise<void>;
    prepared(hash: string, blob: string, lastLedger: number): Promise<void>;
    validated(receipt: Receipt): Promise<void>;
    has(issuanceId: string, holder: string): Promise<boolean>;
    add(issuanceId: string, holder: string): Promise<void>;
}
