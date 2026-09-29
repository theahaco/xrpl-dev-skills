import { existsSync, mkdirSync, rmdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client, Wallet, type SubmittableTransaction, type TransactionMetadata, type LedgerEntry } from 'xrpl';
type MPToken = LedgerEntry.MPToken;
type MPTokenIssuance = LedgerEntry.MPTokenIssuance;
import { readJson, writeJson } from './storage.js';

export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export interface Receipt { hash: string; ledgerIndex: number; code: string; meta: TransactionMetadata }
interface Journal { intent: string; blob: string; hash: string; receipt?: Receipt }
export class LedgerFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`${receipt.code}: ${receipt.hash}`); }
}
export interface LedgerPort {
  send(key: string, tx: SubmittableTransaction): Promise<Receipt>;
  holding(id: string, holder: string): Promise<MPToken | undefined>;
  issuance(id: string): Promise<MPTokenIssuance>;
}
/** Owns a durable journal and a process lock. All use of an issuer must share this writer. */
export class TestnetLedger implements LedgerPort {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(readonly client: Client, private readonly issuer: Wallet, private readonly directory: string) {}
  static async open(issuer: Wallet, directory: string): Promise<TestnetLedger> {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(`${directory}/writer.lock`); // Fail closed if another writer or stale lock exists.
    const client = new Client(TESTNET, { maxFeeXRP: '0.01', timeout: 30_000 });
    try {
      await client.connect();
      const info = (await client.request({ command: 'server_info' })).result.info;
      if (info.network_id !== 1) throw new Error('Refusing non-testnet network');
      const ledger = new TestnetLedger(client, issuer, directory);
      await ledger.reconcilePending();
      return ledger;
    } catch (error) { await client.disconnect(); rmdirSync(`${directory}/writer.lock`); throw error; }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    await this.client.disconnect();
    rmdirSync(`${this.directory}/writer.lock`);
  }
  send(key: string, tx: SubmittableTransaction): Promise<Receipt> { return this.sendAs(key, tx, this.issuer); }
  sendAs(key: string, tx: SubmittableTransaction, signer: Wallet): Promise<Receipt> {
    if (this.closed) return Promise.reject(new Error('Ledger closed'));
    const result = this.tail.then(() => this.submit(key, tx, signer));
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async submit(key: string, tx: SubmittableTransaction, signer: Wallet): Promise<Receipt> {
    if (!key.trim()) throw new Error('An idempotency key is required');
    if (tx.Account !== signer.classicAddress) throw new Error('Signer/account mismatch');
    const path = `${this.directory}/${createHash('sha256').update(key).digest('hex')}.json`;
    const intent = JSON.stringify(tx);
    let journal: Journal;
    if (existsSync(path)) {
      journal = readJson(path) as Journal;
      if (journal.intent !== intent) throw new Error(`Idempotency key reused with different transaction: ${key}`);
    } else {
      // Do not advance past an unresolved submission, even with another operation key.
      for (const file of readdirSync(this.directory).filter(f => f.endsWith('.json'))) {
        const old = readJson(`${this.directory}/${file}`) as Journal;
        if (!old.receipt) throw new Error(`Unresolved transaction ${old.hash}; resume its original operation first`);
      }
      const prepared = await this.client.autofill(tx);
      if (!prepared.LastLedgerSequence || BigInt(prepared.Fee ?? '0') > 10_000n) throw new Error('Unsafe fee/expiry');
      const signed = signer.sign(prepared);
      journal = { intent, blob: signed.tx_blob, hash: signed.hash };
      writeJson(path, journal); // Before broadcast, never persist seed.
    }
    await this.settle(journal, path);
    if (!journal.receipt) throw new Error('Missing receipt');
    if (journal.receipt.code !== 'tesSUCCESS') throw new LedgerFailure(journal.receipt);
    return journal.receipt;
  }
  private async reconcilePending(): Promise<void> {
    for (const file of readdirSync(this.directory).filter(f => f.endsWith('.json'))) {
      const path = `${this.directory}/${file}`;
      const journal = readJson(path) as Journal;
      await this.settle(journal, path);
    }
  }
  private async settle(journal: Journal, path: string): Promise<void> {
    if (!journal.receipt) {
      let result;
      try {
        result = (await this.client.request({ command: 'tx', transaction: journal.hash })).result;
      } catch (error) {
        if (!isRpcError(error, 'txnNotFound')) throw error;
      }
      if (!result?.validated) result = (await this.client.submitAndWait(journal.blob)).result;
      if (!result.validated || typeof result.meta !== 'object' || !result.meta || !result.ledger_index) {
        throw new Error(`Unresolved transaction ${journal.hash}; do not submit a replacement`);
      }
      journal.receipt = { hash: journal.hash, ledgerIndex: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta };
      writeJson(path, journal);
      console.log(`${journal.receipt.code} ${journal.hash}`);
    }
  }
  async entry(request: { mptoken?: { mpt_issuance_id: string; account: string }; mpt_issuance?: string; ledger_index?: number | 'validated' }) {
    const response = await this.client.request({ ...request, command: 'ledger_entry', ledger_index: request.ledger_index ?? 'validated', binary: false });
    if (!response.result.validated) throw new Error('Unvalidated ledger read');
    return response.result.node as LedgerEntry.LedgerEntry | MPToken;
  }
  async holding(id: string, holder: string): Promise<MPToken | undefined> {
    try {
      const node = await this.entry({ mptoken: { mpt_issuance_id: id, account: holder } });
      if (node.LedgerEntryType !== 'MPToken') throw new Error('Wrong ledger entry');
      return { ...node, MPTAmount: node.MPTAmount ?? '0' };
    } catch (error) { if (isRpcError(error, 'entryNotFound')) return undefined; throw error; }
  }
  async issuance(id: string): Promise<MPTokenIssuance> {
    const node = await this.entry({ mpt_issuance: id });
    if (node.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Wrong ledger entry');
    return node;
  }
}
export function isRpcError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'data' in error &&
    typeof error.data === 'object' && error.data !== null && 'error' in error.data && error.data.error === code;
}
