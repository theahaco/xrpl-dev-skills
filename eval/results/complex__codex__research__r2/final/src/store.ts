import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Receipt { hash: string; ledgerIndex: number; code: string; issuanceId?: string }
export interface JournalEntry {
  fingerprint: string;
  blob: string;
  hash: string;
  lastLedgerSequence: number;
  receipt?: Receipt;
}
export interface State {
  version: 1;
  transactions: Record<string, JournalEntry>;
  bans: Record<string, { reason: string; requestedAt: string }>;
}
/** Single-writer durable store. Keep the lock for the entire service lifetime.
 * Production deployments can replace this with a transactional database adapter.
 */
export interface Store {
  readonly state: State;
  save(): Promise<void>;
}
export async function atomicJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  const file = await open(temp, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path);
  const dir = await open(dirname(path), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
export class FileStore implements Store {
  private constructor(readonly path: string, readonly state: State, private readonly release: () => Promise<void>) {}
  static async open(path: string): Promise<FileStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`;
    const lock = await open(lockPath, 'wx', 0o600);
    try {
      await lock.writeFile(String(process.pid));
      let state: State;
      try {
        const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 ||
            !('transactions' in raw) || !raw.transactions || !('bans' in raw) || !raw.bans) {
          throw new Error('Invalid compliance store: refuse to reset it');
        }
        state = raw as State;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        state = { version: 1, transactions: {}, bans: {} };
      }
      const store = new FileStore(path, state, async () => { await lock.close(); await unlink(lockPath); });
      await store.save();
      return store;
    } catch (error) { await lock.close(); await unlink(lockPath); throw error; }
  }
  save(): Promise<void> { return atomicJson(this.path, this.state); }
  close(): Promise<void> { return this.release(); }
}
