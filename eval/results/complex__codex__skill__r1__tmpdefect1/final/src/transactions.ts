import { Client, Wallet, type SubmittableTransaction, type TransactionMetadata } from 'xrpl';
import type { Store } from './store.js';

export interface Receipt { hash: string; ledger: number; code: string; meta: TransactionMetadata }
interface Journal { request: string; blob: string; hash: string; lastLedger: number; receipt?: Receipt }
export class LedgerFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`Validated ${receipt.code}: ${receipt.hash}`); }
}

/** One instance per issuer worker, shared by every operation (including funding). */
export class Transactions {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly client: Client, readonly store: Store) {}
  /** Reconcile a previously broadcast operation without constructing a replacement. */
  resumePending(wallet: Wallet): Promise<Receipt | undefined> {
    const id = this.store.get<string | null>(`pending:${wallet.classicAddress}`);
    if (!id) return Promise.resolve(undefined);
    const journal = this.store.get<Journal>(`tx:${id}`);
    if (!journal) return Promise.reject(new Error('Pending operation journal is missing'));
    return this.submit(id, JSON.parse(journal.request) as SubmittableTransaction, wallet);
  }
  submit(id: string, tx: SubmittableTransaction, wallet: Wallet): Promise<Receipt> {
    const job = this.tail.then(() => this.execute(id, tx, wallet));
    this.tail = job.catch(() => undefined);
    return job;
  }
  private async execute(id: string, tx: SubmittableTransaction, wallet: Wallet): Promise<Receipt> {
    if (tx.Account !== wallet.classicAddress) throw new Error('Signer/account mismatch');
    if (!id) throw new Error('An idempotency key is required');
    const request = JSON.stringify(tx);
    const key = `tx:${id}`;
    let saved = this.store.get<Journal>(key);
    if (saved && saved.request !== request) throw new Error('Idempotency key reused for different transaction');
    const pending = this.store.get<string | null>(`pending:${tx.Account}`);
    if (pending && pending !== id) throw new Error(`Reconcile pending operation ${pending} first`);
    if (!saved) {
      const prepared = await this.client.autofill(tx);
      if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 1000n) {
        throw new Error('Missing expiry or fee exceeds 1000 drops');
      }
      const signed = wallet.sign(prepared);
      saved = { request, blob: signed.tx_blob, hash: signed.hash, lastLedger: prepared.LastLedgerSequence };
      // Write before broadcasting. Never re-sign an ambiguous transaction.
      this.store.put(key, saved);
    }
    if (!saved.receipt) {
      this.store.put(`pending:${tx.Account}`, id);
      let result;
      try {
        result = (await this.client.request({ command: 'tx', transaction: saved.hash })).result;
      } catch (error) {
        if ((error as { data?: { error?: string } }).data?.error !== 'txnNotFound') throw error;
      }
      if (!result?.validated) {
        // submitAndWait handles queued transactions; retries reuse exactly the saved blob.
        // Expiry / past sequence without a validated hash remains blocked for reconciliation.
        result = (await this.client.submitAndWait(saved.blob)).result;
      }
      if (result.validated !== true || typeof result.meta !== 'object' || !result.meta || !result.ledger_index) {
        throw new Error(`Unresolved transaction ${saved.hash}; retry the same operation ID`);
      }
      const receipt: Receipt = { hash: saved.hash, ledger: result.ledger_index,
        code: result.meta.TransactionResult, meta: result.meta };
      saved = { ...saved, receipt };
      this.store.put(key, saved);
    }
    this.store.put(`pending:${tx.Account}`, null);
    const receipt = saved.receipt!;
    if (receipt.code !== 'tesSUCCESS') throw new LedgerFailure(receipt);
    return receipt;
  }
}
