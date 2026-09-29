import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { Client, type SubmittableTransaction, type TxResponse, type Wallet } from 'xrpl';
export const ENDPOINT = 'wss://s.altnet.rippletest.net:51233';
export async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  const file = await open(temp, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path);
  const dir = await open(dirname(path), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
export function rpcError(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && 'data' in e &&
    typeof e.data === 'object' && e.data !== null && 'error' in e.data && e.data.error === code;
}
export interface Signer { readonly classicAddress: string; sign(tx: SubmittableTransaction): ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>> }
interface Entry { intent: string; blob: string; hash: string; lastLedger: number; receipt?: TxResponse }
interface Journal { entries: Record<string, Entry>; pending?: string }
export class LedgerFailure extends Error {
  constructor(readonly code: string, readonly hash: string) { super(`${code}: ${hash}`); }
}
/** One exclusive runtime per issuer. All workflows must use run(). No automatic re-signing. */
export class Runtime {
  private tail: Promise<unknown> = Promise.resolve();
  private journal: Journal = { entries: {} };
  private constructor(readonly client: Client, readonly directory: string) {}
  static async open(directory: string): Promise<Runtime> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(join(directory, 'writer.lock'));
    const runtime = new Runtime(new Client(ENDPOINT, { maxFeeXRP: '0.01', timeout: 20_000 }), directory);
    try {
      runtime.journal = await readJson<Journal>(join(directory, 'journal.json')) ?? { entries: {} };
      await runtime.client.connect();
      await runtime.checkNetwork();
      await runtime.reconcilePending();
      return runtime;
    } catch (e) { await runtime.close(); throw e; }
  }
  async checkNetwork(): Promise<void> {
    const info = await this.client.request({ command: 'server_info' });
    if (info.result.info.network_id !== 1) throw new Error('Refusing non-testnet network');
    const features = await this.client.request({ command: 'feature' });
    for (const name of ['MPTokensV1', 'Clawback', 'DepositAuth', 'DepositPreauth']) {
      if (!Object.values(features.result.features).some(f => f.name === name && f.enabled)) throw new Error(`Required amendment disabled: ${name}`);
    }
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work); this.tail = next.catch(() => undefined); return next;
  }
  async close(): Promise<void> {
    await this.tail;
    if (this.client.isConnected()) await this.client.disconnect();
    await rm(join(this.directory, 'writer.lock'), { recursive: true });
  }
  private save(): Promise<void> { return writeJson(join(this.directory, 'journal.json'), this.journal); }
  audit(): unknown[] {
    return Object.values(this.journal.entries).map(entry => ({
      hash: entry.hash, transaction: JSON.parse(entry.intent) as unknown,
      ledgerIndex: entry.receipt?.result.ledger_index,
      result: typeof entry.receipt?.result.meta === 'object' ? entry.receipt.result.meta.TransactionResult : 'unresolved',
    }));
  }
  /** Resolve saved bytes, never replace a timed-out payment with a new transaction. */
  async reconcilePending(): Promise<void> {
    const key = this.journal.pending;
    if (!key) return;
    const entry = this.journal.entries[key];
    if (!entry) throw new Error('Corrupt journal: pending entry missing');
    let receipt: TxResponse | undefined;
    try {
      const found = await this.client.request({ command: 'tx', transaction: entry.hash });
      if (found.result.validated) receipt = found;
    } catch (e) { if (!rpcError(e, 'txnNotFound')) throw e; }
    if (!receipt) receipt = await this.client.submitAndWait(entry.blob);
    if (!receipt.result.validated || typeof receipt.result.meta !== 'object') throw new Error(`Unresolved transaction ${entry.hash}`);
    entry.receipt = receipt;
    delete this.journal.pending;
    await this.save();
  }
  /** Call inside run(); id is a stable business operation ID, never reused for different intent. */
  async send(id: string, tx: SubmittableTransaction, signer: Signer): Promise<TxResponse> {
    if (!id || tx.Account !== signer.classicAddress) throw new Error('Invalid operation ID or signer');
    const key = createHash('sha256').update(id).digest('hex');
    const intent = JSON.stringify(tx);
    let entry = this.journal.entries[key];
    if (entry && entry.intent !== intent) throw new Error(`Operation ID reused: ${id}`);
    if (!entry?.receipt && this.journal.pending && this.journal.pending !== key) throw new Error('Unresolved transaction: reconcile pending journal entry first');
    if (!entry) {
      const prepared = await this.client.autofill(tx);
      if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 10_000n) throw new Error('Unsafe fee or expiry');
      const signed = await signer.sign(prepared);
      entry = { intent, blob: signed.tx_blob, hash: signed.hash, lastLedger: prepared.LastLedgerSequence };
      this.journal.entries[key] = entry; this.journal.pending = key;
      await this.save();
    }
    if (!entry.receipt) {
      let receipt: TxResponse | undefined;
      try {
        const found = await this.client.request({ command: 'tx', transaction: entry.hash });
        if (found.result.validated) receipt = found;
      } catch (e) { if (!rpcError(e, 'txnNotFound')) throw e; }
      if (!receipt) receipt = await this.client.submitAndWait(entry.blob);
      if (!receipt.result.validated || typeof receipt.result.meta !== 'object') throw new Error(`Unresolved transaction ${entry.hash}`);
      entry.receipt = receipt; delete this.journal.pending; await this.save();
      console.log(`${id}: ${receipt.result.meta.TransactionResult} ${entry.hash}`);
    }
    const meta = entry.receipt.result.meta;
    if (typeof meta !== 'object') throw new Error('Missing transaction metadata');
    if (meta.TransactionResult !== 'tesSUCCESS') throw new LedgerFailure(meta.TransactionResult, entry.hash);
    return entry.receipt;
  }
}
