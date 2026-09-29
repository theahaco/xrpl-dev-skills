import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/** Implement with a transactional database and an issuer-wide worker lease in a distributed backend. */
export interface Store {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

/** Single-process durable store; the caller must hold an exclusive process lock. */
export class FileStore implements Store {
  private data: Record<string, unknown>;
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { this.data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.data = {};
    }
  }
  get<T>(key: string): T | undefined { return this.data[key] as T | undefined; }
  /** Audit export intentionally excludes signed blobs and wallet secrets. */
  receipts(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this.data).filter(([key]) => key.startsWith('tx:'))
      .map(([key, value]) => [key.slice(3), (value as { receipt?: unknown }).receipt])
      .filter(([, receipt]) => receipt !== undefined));
  }
  put<T>(key: string, value: T): void {
    const next = { ...this.data, [key]: value };
    const temporary = `${this.path}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(next, null, 2)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, this.path);
    const directory = openSync(dirname(this.path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    this.data = next;
  }
}
