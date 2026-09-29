import { open, readFile, mkdir } from 'node:fs/promises';
import type { BanStore, Journal, Receipt } from './issuer.js';
/** Local single-process adapter. Backend deployments should use a transactional database. */
export class FileStore implements BanStore, Journal {
  constructor(readonly directory: string) {}
  private async append(file: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const f = await open(`${this.directory}/${file}`, 'a', 0o600);
    try { await f.writeFile(JSON.stringify(value) + '\n'); await f.sync(); } finally { await f.close(); }
  }
  async records(file: string): Promise<Record<string, unknown>[]> {
    try { return (await readFile(`${this.directory}/${file}`, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }
  async assertNoPending(): Promise<void> {
    const entries = await this.records('transactions.jsonl');
    const pending = new Set<string>();
    for (const e of entries) { if (e.kind === 'prepared') pending.add(String(e.hash)); else pending.delete(String(e.hash)); }
    if (pending.size) throw new Error(`Reconcile pending transaction hashes before rerun: ${[...pending].join(', ')}`);
  }
  prepared(hash: string, blob: string, lastLedger: number): Promise<void> { return this.append('transactions.jsonl', { kind: 'prepared', hash, blob, lastLedger }); }
  validated(receipt: Receipt): Promise<void> { return this.append('transactions.jsonl', { kind: 'validated', ...receipt }); }
  async has(issuanceId: string, holder: string): Promise<boolean> { return (await this.records('bans.jsonl')).some(e => e.issuanceId === issuanceId && e.holder === holder); }
  async add(issuanceId: string, holder: string): Promise<void> { if (!(await this.has(issuanceId, holder))) await this.append('bans.jsonl', { issuanceId, holder }); }
}
