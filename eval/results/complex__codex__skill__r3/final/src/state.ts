import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { TransactionMetadata } from 'xrpl';

export interface Receipt { hash: string; ledgerIndex: number; code: string; meta: TransactionMetadata }
export interface Pending { intent: string; blob: string; hash: string; lastLedger: number; receipt?: Receipt }
export interface StateData {
  version: 1;
  transactions: Record<string, Pending>;
  bans: Record<string, { reason: string; startedAt: string; complete: boolean }>;
  demoSalt?: string;
}
/** Backend adapters must provide durable writes and exclusive ownership for the entire issuer workflow. */
export interface StateStore { data: StateData; save(): Promise<void> }

/** Single-host, single-writer store. A stale lock requires operator reconciliation, never automatic deletion. */
export class FileState implements StateStore {
  private constructor(readonly directory: string, public data: StateData) {}
  static async open(directory: string): Promise<FileState> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await open(join(directory, 'writer.lock'), 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await lock.close();
    try {
      let data: StateData;
      try {
        data = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as StateData;
        if (data.version !== 1 || !data.transactions || !data.bans) throw new Error('Invalid state file');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        data = { version: 1, transactions: {}, bans: {} };
      }
      return new FileState(directory, data);
    } catch (error) { await unlink(join(directory, 'writer.lock')); throw error; }
  }
  private readonly writes = new SerialQueue();
  save(): Promise<void> { return this.writes.run(() => this.flush()); }
  private async flush(): Promise<void> {
    const file = await open(join(this.directory, 'state.tmp'), 'w', 0o600);
    try { await file.writeFile(JSON.stringify(this.data, null, 2)); await file.sync(); }
    finally { await file.close(); }
    await rename(join(this.directory, 'state.tmp'), join(this.directory, 'state.json'));
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async close(): Promise<void> { await unlink(join(this.directory, 'writer.lock')); }
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
