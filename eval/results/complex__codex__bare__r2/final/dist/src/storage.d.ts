/** Atomic replacement plus fsync; single writer only. Keep this directory backed up. */
export declare function writeJson(path: string, value: unknown): void;
export declare function readJson(path: string): unknown;
export interface BanStore {
    has(issuanceId: string, holder: string): Promise<boolean>;
    add(issuanceId: string, holder: string): Promise<void>;
}
/** Append-only policy: intentionally no unban method. Corrupt state fails closed. */
export declare class FileBanStore implements BanStore {
    private readonly path;
    constructor(path: string);
    private read;
    has(id: string, holder: string): Promise<boolean>;
    add(id: string, holder: string): Promise<void>;
}
