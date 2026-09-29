import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

/** Implement with durable, access-controlled storage. One exclusive writer per issuer. */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
/** Single-writer filesystem adapter. Files can contain signed transactions and demo keys. */
export class FileStore implements Store {
  constructor(private readonly directory: string) {}
  private path(key: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('Invalid storage key');
    return join(this.directory, `${key}.json`);
  }
  async get<T>(key: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.path(key), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async put<T>(key: string, value: T): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(key);
    const file = await open(`${path}.tmp`, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
    finally { await file.close(); }
    await rename(`${path}.tmp`, path);
    const dir = await open(this.directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
}
