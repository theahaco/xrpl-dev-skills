import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmdirSync, chmodSync } from 'node:fs';
import { Client, type SubmittableTransaction, type TransactionMetadata, type TxResponse } from 'xrpl';

export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
export function rpcCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } })?.data?.error;
}
export interface Receipt {
  hash: string;
  ledger: number;
  code: string;
  meta: TransactionMetadata;
}
interface Stored { intent: string; blob: string; hash: string; receipt: string | null }
/** One durable journal and one process per issuer. Never delete a pending operation. */
export class Journal {
  readonly db: DatabaseSync;
  private readonly lock: string;
  constructor(path: string) {
    this.lock = `${path}.lock`;
    mkdirSync(this.lock); // Cross-process exclusion; stale locks require deliberate recovery.
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, intent TEXT NOT NULL, blob TEXT NOT NULL, hash TEXT NOT NULL, receipt TEXT);
      CREATE TABLE IF NOT EXISTS bans (issuance TEXT, holder TEXT, reason TEXT NOT NULL, PRIMARY KEY(issuance,holder));
      CREATE TABLE IF NOT EXISTS values_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM values_store WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  set(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO values_store VALUES (?,?)').run(key, JSON.stringify(value));
  }
  banned(id: string, holder: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bans WHERE issuance=? AND holder=?').get(id, holder);
  }
  ban(id: string, holder: string, reason: string): void {
    this.db.prepare('INSERT OR IGNORE INTO bans VALUES (?,?,?)').run(id, holder, reason);
  }
  close(): void { this.db.close(); rmdirSync(this.lock); }
}
export class TransactionFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`Validated transaction ${receipt.hash}: ${receipt.code}`); }
}
export interface Signer { address: string; sign(tx: SubmittableTransaction): { tx_blob: string; hash: string } }
export class Runner {
  private readonly serial = new Serial();
  constructor(readonly client: Client, readonly journal: Journal) {}
  async preflight() {
    const server = (await this.client.request({ command: 'server_info' })).result.info;
    invariant(server.network_id === 1, 'Refusing non-testnet network');
    invariant(server.validated_ledger && server.validated_ledger.age < 60, 'Stale ledger');
    const features = (await this.client.request({ command: 'feature' })).result.features;
    for (const name of ['MPTokensV1', 'Clawback', 'DepositAuth', 'DepositPreauth']) {
      invariant(Object.values(features).some(f => f.name === name && f.enabled), `${name} is not enabled`);
    }
    return { server, features };
  }
  execute(id: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt> {
    return this.serial.run(async () => {
      invariant(id.length > 0, 'An idempotency key is required');
      invariant(tx.Account === signer.address, 'Signer/account mismatch');
      const intent = JSON.stringify(tx);
      let stored = this.journal.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as unknown as Stored | undefined;
      if (stored) {
        invariant(stored.intent === intent, `Idempotency key reused with different request: ${id}`);
        if (!stored.receipt) await this.preflight(); // Never replay a signed blob on another network.
      }
      if (!stored) {
        // Do not advance any account past an unresolved transaction, including after restart.
        invariant(!this.journal.db.prepare('SELECT id FROM operations WHERE receipt IS NULL').get(), 'Unresolved transaction: resume its original operation first');
        await this.preflight();
        const prepared = await this.client.autofill(tx);
        invariant(prepared.LastLedgerSequence, 'Missing transaction expiry');
        invariant(prepared.Fee && BigInt(prepared.Fee) <= 10000n, 'Fee exceeds 0.01 XRP ceiling');
        const signed = signer.sign(prepared);
        this.journal.db.prepare('INSERT INTO operations VALUES (?,?,?,?,NULL)').run(id, intent, signed.tx_blob, signed.hash);
        stored = { intent, blob: signed.tx_blob, hash: signed.hash, receipt: null };
      }
      let receipt: Receipt;
      if (stored.receipt) receipt = JSON.parse(stored.receipt) as Receipt;
      else {
        let response: TxResponse | undefined;
        try { response = await this.client.request({ command: 'tx', transaction: stored.hash }); }
        catch (error) { if (rpcCode(error) !== 'txnNotFound') throw error; }
        // Retry only the identical signed blob. Ambiguous/expired outcomes stop the workflow.
        if (!response?.result.validated) response = await this.client.submitAndWait(stored.blob);
        const result = response.result;
        invariant(result.validated && result.meta && typeof result.meta !== 'string', `Unvalidated outcome: ${stored.hash}`);
        invariant(result.ledger_index !== undefined, 'Missing validated ledger index');
        receipt = { hash: stored.hash, ledger: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta };
        this.journal.db.prepare('UPDATE operations SET receipt=? WHERE id=?').run(JSON.stringify(receipt), id);
        console.log(`${id}: ${receipt.code} (${receipt.hash})`);
      }
      if (receipt.code !== 'tesSUCCESS') throw new TransactionFailure(receipt);
      return receipt;
    });
  }
}
