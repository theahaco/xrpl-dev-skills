import { createHash } from 'node:crypto';
import { Client, type SubmittableTransaction, type TransactionMetadata, type Wallet } from 'xrpl';
import type { Store } from './store.js';

export interface Signer {
  readonly classicAddress: string;
  sign(tx: SubmittableTransaction): ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
}
export interface Receipt { hash: string; ledger: number; code: string; meta: TransactionMetadata }
interface Journal { fingerprint: string; blob: string; hash: string; lastLedger: number; receipt?: Receipt }
export class LedgerFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`Validated transaction ${receipt.hash}: ${receipt.code}`); }
}
export class UncertainSubmission extends Error {
  constructor(readonly hash: string, options?: ErrorOptions) {
    super(`Submission unresolved: ${hash}. Retry the SAME operation ID to reconcile; never mint with a new ID.`, options);
  }
}
/** Serializes one process. Backend must also hold an exclusive distributed issuer lock. */
export class Transactions {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly client: Client, private readonly store: Store) {}
  submit(id: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt> {
    const next = this.tail.then(() => this.execute(id, tx, signer));
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async execute(id: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt> {
    if (tx.Account !== signer.classicAddress) throw new Error('Signer/account mismatch');
    const info = await this.client.request({ command: 'server_info' });
    if (info.result.info.network_id !== 1) throw new Error('Only XRPL testnet (network 1) is permitted');
    const fingerprint = createHash('sha256').update(JSON.stringify(tx)).digest('hex');
    const key = `tx-${createHash('sha256').update(id).digest('hex')}`;
    let journal = await this.store.get<Journal>(key);
    if (journal && journal.fingerprint !== fingerprint) throw new Error('Operation ID reused with different transaction');
    if (!journal) {
      const prepared = await this.client.autofill(tx);
      if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 1000n) throw new Error('Missing expiry or fee exceeds 0.001 XRP');
      const signed = await signer.sign(prepared);
      journal = { fingerprint, blob: signed.tx_blob, hash: signed.hash, lastLedger: prepared.LastLedgerSequence };
      await this.store.put(key, journal); // Durable BEFORE sending; identical blob is safe to retry.
    }
    if (!journal.receipt) {
      try {
        // First reconcile previously submitted transactions, including after a process crash.
        const found = await this.client.request({ command: 'tx', transaction: journal.hash });
        if (found.result.validated && typeof found.result.meta === 'object') {
          journal.receipt = { hash: journal.hash, ledger: found.result.ledger_index!, code: found.result.meta.TransactionResult, meta: found.result.meta };
        }
      } catch (error) {
        if ((error as { data?: { error?: string } }).data?.error !== 'txnNotFound') throw new UncertainSubmission(journal.hash, { cause: error });
      }
      if (!journal.receipt) {
        try {
          const result = (await this.client.submitAndWait(journal.blob)).result;
          if (!result.validated || typeof result.meta !== 'object' || !result.ledger_index) throw new Error('Unvalidated response');
          journal.receipt = { hash: journal.hash, ledger: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta };
        } catch (error) { throw new UncertainSubmission(journal.hash, { cause: error }); }
      }
      await this.store.put(key, journal);
    }
    if (journal.receipt.code !== 'tesSUCCESS') throw new LedgerFailure(journal.receipt);
    return journal.receipt;
  }
}
