import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BanStore, Journal, PreparedRecord, Receipt } from './issuer.js';

/** Append-only, fsync'd store for ONE process. Backends should supply database adapters. */
export class FileStore implements BanStore, Journal {
  constructor(readonly path: string) {}
  async append(event: object): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const file = await open(this.path, 'a', 0o600);
    try { await file.writeFile(JSON.stringify(event) + '\n'); await file.sync(); } finally { await file.close(); }
  }
  async events(): Promise<Record<string, unknown>[]> {
    try {
      return (await readFile(this.path, 'utf8')).split('\n').filter(Boolean).map((line: string) => {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Corrupt event log');
        return value as Record<string, unknown>;
      });
    } catch (e) { if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') return []; throw e; }
  }
  async assertReady(account: string) {
    const events = await this.events();
    const settled = new Set(events.filter(e => e.type === 'settled').map(e => e.hash));
    for (const e of events) {
      const tx = e.transaction;
      if (e.type === 'prepared' && typeof tx === 'object' && tx !== null && 'Account' in tx && tx.Account === account && !settled.has(e.hash)) throw new Error(`Unreconciled transaction ${String(e.hash)}; reconcile before new submissions`);
    }
  }
  prepared(record: PreparedRecord) { return this.append({ type: 'prepared', ...record }); }
  settled(receipt: Receipt) { return this.append({ type: 'settled', ...receipt }); }
  async isBanned(issuanceId: string, holder: string) {
    return (await this.events()).some(e => e.type === 'ban' && e.issuanceId === issuanceId && e.holder === holder);
  }
  async ban(issuanceId: string, holder: string) { await this.append({ type: 'ban', issuanceId, holder }); }
}
