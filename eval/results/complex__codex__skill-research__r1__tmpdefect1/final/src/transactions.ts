import { Client, type SubmittableTransaction as Transaction, type TransactionMetadata, type Wallet } from 'xrpl';
import { isDeepStrictEqual } from 'node:util';
import { readJson, saveJson, acquireLock } from './storage.js';

export interface Signer {
  readonly classicAddress: string;
  sign(tx: Transaction): ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
}
export interface Receipt { hash: string; ledger: number; code: string; meta: TransactionMetadata }
interface Entry { intent: Transaction; blob: string; hash: string; receipt?: Receipt }
interface Journal { version: 1; entries: Record<string, Entry>; bans: Record<string, string> }
export class TransactionFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`Validated transaction ${receipt.hash}: ${receipt.code}`); }
}
export class UnresolvedTransaction extends Error {
  constructor(readonly hash: string, options?: ErrorOptions) {
    super(`Transaction ${hash} unresolved; reconcile this hash before issuing another operation.`, options);
  }
}
/** Single writer, durable idempotency and signed-before-submit journal. Keep open per issuer. */
export class TransactionRunner {
  private readonly journal: Journal;
  private readonly release: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private queued = 0;
  constructor(readonly client: Client, private readonly path: string) {
    this.release = acquireLock(`${path}.lock`);
    try {
      this.journal = readJson<Journal>(path, { version: 1, entries: {}, bans: {} });
      if (this.journal.version !== 1) throw new Error('Unsupported journal version');
    } catch (error) { this.release(); throw error; }
  }
  close(): void {
    if (this.queued) throw new Error('Await all issuer operations before closing the runner');
    if (!this.closed) { this.closed = true; this.release(); }
  }
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Runner is closed'));
    this.queued++;
    const next = this.queue.then(work).finally(() => { this.queued--; });
    this.queue = next.catch(() => undefined);
    return next;
  }
  isBanned(id: string, holder: string): boolean { return this.journal.bans[`${id}:${holder}`] !== undefined; }
  hasOperation(key: string): boolean { return Object.hasOwn(this.journal.entries, key); }
  markBanned(id: string, holder: string, reason: string): void {
    if (this.closed) throw new Error('Runner is closed');
    if (!reason.trim()) throw new Error('A ban requires an audit reason');
    this.journal.bans[`${id}:${holder}`] ??= reason; this.persist();
  }
  private persist(): void { saveJson(this.path, this.journal); }
  /** Call under exclusive(). Repeat the SAME key and intent after any timeout. */
  async send(key: string, intent: Transaction, signer: Signer): Promise<Receipt> {
    if (this.closed) throw new Error('Runner is closed');
    if (!/^[a-zA-Z0-9:._-]{1,200}$/.test(key) || key in Object.prototype) throw new Error('Invalid operation key');
    if (intent.Account !== signer.classicAddress) throw new Error('Signer account mismatch');
    let entry = this.journal.entries[key];
    if (entry && !isDeepStrictEqual(entry.intent, intent)) throw new Error('Operation key reused for a different transaction');
    if (!entry?.receipt) {
      const info = await this.client.request({ command: 'server_info' });
      if (info.result.info.network_id !== 1) throw new Error('Testnet network_id=1 required');
    }
    if (!entry) {
      const pending = Object.values(this.journal.entries).find(e => !e.receipt);
      if (pending) throw new UnresolvedTransaction(pending.hash);
      const tx = await this.client.autofill(intent);
      if (!tx.LastLedgerSequence || !tx.Fee || BigInt(tx.Fee) > 10_000n) throw new Error('Invalid expiry or fee above 0.01 XRP');
      const signed = await signer.sign(tx);
      entry = { intent, blob: signed.tx_blob, hash: signed.hash };
      this.journal.entries[key] = entry;
      this.persist();
    }
    if (!entry.receipt) {
      try {
        let result;
        try { result = (await this.client.request({ command: 'tx', transaction: entry.hash })).result; }
        catch (error) { if (!isRpcError(error, 'txnNotFound')) throw error; }
        if (!result?.validated) result = (await this.client.submitAndWait(entry.blob)).result;
        if (!result.validated || !result.ledger_index || !result.meta || typeof result.meta === 'string') throw new Error('Missing validated metadata');
        entry.receipt = { hash: entry.hash, ledger: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta };
        this.persist();
      } catch (cause) { throw new UnresolvedTransaction(entry.hash, { cause }); }
    }
    if (!entry.receipt) throw new UnresolvedTransaction(entry.hash);
    if (entry.receipt.code !== 'tesSUCCESS') throw new TransactionFailure(entry.receipt);
    return entry.receipt;
  }
}
export function isRpcError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'data' in error &&
    typeof error.data === 'object' && error.data !== null && 'error' in error.data && error.data.error === code;
}
