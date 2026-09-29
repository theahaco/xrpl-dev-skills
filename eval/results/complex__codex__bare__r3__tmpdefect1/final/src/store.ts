import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Durable storage, held exclusively for the entire service lifetime. */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('data' in error && typeof error.data === 'object' && error.data !== null &&
      'error' in error.data && typeof error.data.error === 'string') return error.data.error;
  return undefined;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Single-host reference adapter. A stale lock requires operator reconciliation, never auto-removal. */
export class FileStore implements Store {
  private constructor(private readonly path: string, private readonly values: Record<string, unknown>) {}
  static async open(path: string): Promise<FileStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lock = await open(`${path}.lock`, 'wx', 0o600);
    await lock.writeFile(String(process.pid));
    await lock.close();
    try {
      let values: unknown = {};
      try { values = JSON.parse(await readFile(path, 'utf8')) as unknown; }
      catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error('Invalid store');
      return new FileStore(path, values as Record<string, unknown>);
    } catch (error) { await unlink(`${path}.lock`); throw error; }
  }
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values[key]) as T | undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    const next = { ...this.values, [key]: structuredClone(value) };
    await atomicJson(this.path, next);
    this.values[key] = structuredClone(value);
  }
  async close(): Promise<void> { await unlink(`${this.path}.lock`); }
}
