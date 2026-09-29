import { mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Atomic replacement plus fsync; single writer only. Keep this directory backed up. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
export interface BanStore {
  has(issuanceId: string, holder: string): Promise<boolean>;
  add(issuanceId: string, holder: string): Promise<void>;
}
/** Append-only policy: intentionally no unban method. Corrupt state fails closed. */
export class FileBanStore implements BanStore {
  constructor(private readonly path: string) {}
  private read(): string[] {
    if (!existsSync(this.path)) return [];
    const value = readJson(this.path);
    if (!Array.isArray(value) || !value.every(x => typeof x === 'string')) throw new Error('Corrupt ban store');
    return value as string[];
  }
  async has(id: string, holder: string): Promise<boolean> { return this.read().includes(`${id}:${holder}`); }
  async add(id: string, holder: string): Promise<void> {
    writeJson(this.path, [...new Set([...this.read(), `${id}:${holder}`])]);
  }
}
