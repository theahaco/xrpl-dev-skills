import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Receipt {
  hash: string;
  ledgerIndex: number;
  code: string;
  issuanceId?: string;
}
export interface PendingTransaction {
  intent: string;
  blob: string;
  hash: string;
  lastLedgerSequence: number;
  receipt?: Receipt;
}
export interface State {
  version: 1;
  network: 'testnet';
  issuer: string;
  transactions: Record<string, PendingTransaction>;
  bans: Record<string, { reason: string; requestedAt: string; completed: boolean }>;
  steps: Record<string, boolean>;
  issuanceId?: string;
}

/** Single-writer, fsync-backed local adapter. Keep this directory on a local durable disk.
 * A multi-host deployment must substitute a transactional database and distributed lock.
 * Never automatically remove a stale lock: first establish the old worker is dead.
 */
export class FileStore {
  readonly state: State;
  private readonly lock: number;
  private closed = false;
  constructor(readonly directory: string, issuer: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = openSync(join(directory, 'writer.lock'), 'wx', 0o600);
    try {
      writeFileSync(this.lock, String(process.pid));
      fsyncSync(this.lock);
      const path = join(directory, 'state.json');
      this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as State : {
        version: 1, network: 'testnet', issuer, transactions: {}, bans: {}, steps: {},
      };
      if (this.state.version !== 1 || this.state.network !== 'testnet' || this.state.issuer !== issuer ||
          !this.state.transactions || !this.state.bans || !this.state.steps) throw new Error('Invalid store or issuer mismatch');
      this.save();
    } catch (error) { this.close(); throw error; }
  }
  save(): void {
    if (this.closed) throw new Error('Store closed');
    atomicJson(join(this.directory, 'state.json'), this.state);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.lock);
    unlinkSync(join(this.directory, 'writer.lock'));
  }
}

export function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, path);
  const parent = openSync(join(path, '..'), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
