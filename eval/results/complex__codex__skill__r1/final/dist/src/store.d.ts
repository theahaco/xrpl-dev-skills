/** Implement with durable, access-controlled storage. One exclusive writer per issuer. */
export interface Store {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
}
/** Single-writer filesystem adapter. Files can contain signed transactions and demo keys. */
export declare class FileStore implements Store {
    private readonly directory;
    constructor(directory: string);
    private path;
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
}
