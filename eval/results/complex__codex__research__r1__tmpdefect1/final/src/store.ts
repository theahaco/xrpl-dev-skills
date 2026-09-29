import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

/** Single-writer durable JSON storage. Use one directory for every operation on an issuer.
 * A stale lock requires operator reconciliation; it is never silently stolen. */
export class FileStore {
  readonly directory: string;
  private readonly lock: string;
  private closed = false;
  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.lock = join(this.directory, 'writer.lock');
    const fd = openSync(this.lock, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() })); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  read<T>(name: string): T | undefined {
    const path = this.path(name);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : undefined;
  }
  write(name: string, value: unknown): void { atomicJson(this.path(name), value); }
  private path(name: string): string {
    if (this.closed) throw new Error('Store is closed');
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid store key');
    return join(this.directory, `${name}.json`);
  }
  close(): void { if (!this.closed) { unlinkSync(this.lock); this.closed = true; } }
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
