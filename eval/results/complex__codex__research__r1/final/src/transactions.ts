import { createHash } from 'node:crypto';
import { Client, type SubmittableTransaction, type TransactionMetadata, type Wallet } from 'xrpl';
import { FileStore, type Receipt } from './store.js';

export interface Signer {
  classicAddress: string;
  sign: (transaction: SubmittableTransaction) => ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
}
export class TransactionRejected extends Error {
  constructor(readonly receipt: Receipt) { super(`${receipt.code}: ${receipt.hash}`); }
}
export class SubmissionUncertain extends Error {
  constructor(readonly operationId: string, readonly hash: string, cause: unknown) {
    super(`Submission unresolved for ${operationId} (${hash}). Resume the same operation; do not issue a replacement.`, { cause });
  }
}

/** Stable sorting makes idempotency independent of object property insertion order. */
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) :
    v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** All issuer and demo holder transactions share one serialized, durable submission queue. */
export class Transactions {
  private tail: Promise<unknown> = Promise.resolve();
  private operations: Promise<unknown> = Promise.resolve();
  constructor(readonly client: Client, readonly store: FileStore) {}
  /** Serialize whole compliance workflows across all modules sharing this writer. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.operations.then(fn); this.operations = task.catch(() => undefined); return task;
  }
  send(id: string, transaction: SubmittableTransaction, signer: Signer, before?: () => Promise<void>): Promise<Receipt> {
    const task = this.tail.then(() => this.execute(id, transaction, signer, before));
    this.tail = task.catch(() => undefined);
    return task;
  }
  private async execute(id: string, transaction: SubmittableTransaction, signer: Signer, before?: () => Promise<void>): Promise<Receipt> {
    if (!/^[a-zA-Z0-9:/._-]{1,180}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid operation ID');
    if (transaction.Account !== signer.classicAddress) throw new Error('Signer/account mismatch');
    const intent = fingerprint(transaction);
    let record = this.store.state.transactions[id];
    if (record && record.intent !== intent) throw new Error('Operation ID reused with different transaction');
    if (record?.receipt) { this.store.save(); return this.checked(record.receipt); }
    const pending = Object.entries(this.store.state.transactions).find(([key, value]) => key !== id && !value.receipt);
    if (pending) throw new Error(`Resolve pending operation ${pending[0]} before submitting another transaction`);
    const info = await this.client.request({ command: 'server_info' });
    if (info.result.info.network_id !== 1) throw new Error('Refusing to sign outside XRPL testnet (network_id 1)');
    if (!info.result.info.validated_ledger || info.result.info.validated_ledger.age > 60) throw new Error('Server validated ledger is stale or missing');
    if (!record) {
      await before?.();
      const prepared = await this.client.autofill(transaction);
      if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 1000n) throw new Error('Missing expiry or fee exceeds 1000 drops');
      const signed = await signer.sign(prepared);
      record = { intent, blob: signed.tx_blob, hash: signed.hash, lastLedgerSequence: prepared.LastLedgerSequence };
      this.store.state.transactions[id] = record;
      this.store.save(); // Must commit the signed transaction before it can reach the network.
    }
    // A failed fsync on an earlier attempt must not permit an in-memory-only record to be submitted.
    this.store.save();
    try {
      // Reconcile first. A previous process may have died after validation but before save().
      let response;
      try { response = await this.client.request({ command: 'tx', transaction: record.hash, binary: false }); }
      catch (error) { if (!isRpcError(error, 'txnNotFound')) throw error; }
      if (!response?.result.validated) response = await this.client.submitAndWait(record.blob);
      const result = response.result;
      if (!result.validated || !result.ledger_index || !result.meta || typeof result.meta === 'string') throw new Error('Missing validated transaction metadata');
      const meta = result.meta as TransactionMetadata & { mpt_issuance_id?: string };
      const receipt: Receipt = { hash: record.hash, ledgerIndex: result.ledger_index, code: meta.TransactionResult,
        ...(meta.mpt_issuance_id ? { issuanceId: meta.mpt_issuance_id } : {}) };
      record.receipt = receipt;
      this.store.save();
      console.log(`${id}: ${receipt.code} ${receipt.hash}`);
      return this.checked(receipt);
    } catch (error) {
      if (error instanceof TransactionRejected) throw error;
      throw new SubmissionUncertain(id, record.hash, error);
    }
  }
  private checked(receipt: Receipt): Receipt {
    if (receipt.code !== 'tesSUCCESS') throw new TransactionRejected(receipt);
    return receipt;
  }
}

export function isRpcError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'data' in error &&
    typeof error.data === 'object' && error.data !== null && 'error' in error.data && error.data.error === code;
}
