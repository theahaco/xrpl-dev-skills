import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Must be durable before resolving. Use a transactional database with multiple workers. */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** Single-process adapter. Enforce one writer per issuer and store. */
export class FileStore implements Store {
  private constructor(private readonly path: string, private readonly data: Record<string, unknown>) {}
  static async open(path: string): Promise<FileStore> {
    try {
      const data: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid store');
      return new FileStore(path, data as Record<string, unknown>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return new FileStore(path, {});
    }
  }
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data[key]) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> {
    const next = { ...this.data, [key]: structuredClone(value) };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp`;
    const file = await open(temp, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(next, null, 2)); await file.sync(); } finally { await file.close(); }
    await rename(temp, this.path);
    const dir = await open(dirname(this.path), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    Object.assign(this.data, next);
  }
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
