import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/** Atomic replacement plus fsync. Never store seeds in this store. */
export function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function readJson<T>(path: string, initial: T): T {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : initial;
}
/** Exclusive writer for the store's entire lifetime. Crashes leave a lock for operator review. */
export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  return () => unlinkSync(path);
}
