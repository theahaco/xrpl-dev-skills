import { Client, isValidClassicAddress, type SubmittableTransaction, type Transaction, type TxResponse } from 'xrpl';
import { Store, Serial } from './store.js';

export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export interface Signer {
  readonly classicAddress: string;
  sign(tx: Transaction): { tx_blob: string; hash: string } | Promise<{ tx_blob: string; hash: string }>;
}
export interface Receipt { hash: string; ledger: number; code: string; issuanceId?: string }
interface Journal {
  intent: string; account: string; blob: string; hash: string; lastLedger: number;
  receipt?: Receipt;
}
export class LedgerFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`Validated transaction ${receipt.hash}: ${receipt.code}`); }
}
export class UnresolvedTransaction extends Error {
  constructor(readonly hash: string, options?: ErrorOptions) {
    super(`Outcome unresolved for ${hash}; reconcile this hash before creating a replacement`, options);
  }
}
export function address(value: string): string {
  if (!isValidClassicAddress(value)) throw new Error('Invalid classic address');
  return value;
}
export function rpcError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined;
  const data = error.data;
  return typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : undefined;
}
export async function preflight(client: Client) {
  const info = (await client.request({ command: 'server_info' })).result.info;
  if (info.network_id !== 1) throw new Error('This module is restricted to XRPL testnet (network ID 1)');
  const amendments = (await client.request({ command: 'ledger_entry', ledger_index: 'validated',
    index: '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4' })).result;
  if (!amendments.validated || amendments.node.LedgerEntryType !== 'Amendments') throw new Error('Unvalidated amendment state');
  const enabled = amendments.node.Amendments ?? [];
  for (const id of [
    '950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38',
    '56B241D7A43D40354D02A9DC4C8DF5C7A1F930D92A9035C4E12291B3CA3E1C2B',
  ]) if (!enabled.includes(id)) throw new Error(`Required amendment disabled: ${id}`);
  return { info, enabledAmendments: enabled };
}

/** Durable idempotency keys, bounded fees and no automatic replacement of ambiguous submissions. */
export class Submitter {
  private readonly serial = new Serial();
  readonly operations = new Serial();
  constructor(readonly client: Client, readonly store: Store) {}
  submit(key: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt> {
    return this.serial.run(async () => {
      if (!key || tx.Account !== signer.classicAddress) throw new Error('Invalid operation key or signer');
      const intent = JSON.stringify(tx);
      let job = this.store.get<Journal>(`tx:${key}`);
      if (job && job.intent !== intent) throw new Error(`Idempotency key reused with different transaction: ${key}`);
      if (!job) {
        if (this.store.entries<Journal>('tx:').some(([, row]) => row.account === tx.Account && !row.receipt)) {
          throw new Error('Account has an unresolved transaction; retry its original operation key first');
        }
        await preflight(this.client);
        const filled = await this.client.autofill(tx);
        if (!filled.LastLedgerSequence || !filled.Fee || BigInt(filled.Fee) > 1000n) throw new Error('Missing expiry or fee exceeds 1000 drops');
        const signed = await signer.sign(filled);
        job = { intent, account: tx.Account, blob: signed.tx_blob, hash: signed.hash, lastLedger: filled.LastLedgerSequence };
        this.store.set(`tx:${key}`, job); // Commit before broadcasting.
      }
      if (!job.receipt) {
        let result: TxResponse['result'] | undefined;
        try {
          try { result = (await this.client.request({ command: 'tx', transaction: job.hash })).result; }
          catch (error) { if (rpcError(error) !== 'txnNotFound') throw error; }
          if (!result?.validated) result = (await this.client.submitAndWait(job.blob)).result;
          const meta = result.meta;
          if (!result.validated || !result.ledger_index || !meta || typeof meta === 'string') throw new Error('Missing validated metadata');
          job.receipt = { hash: job.hash, ledger: result.ledger_index, code: meta.TransactionResult,
            ...('mpt_issuance_id' in meta && typeof meta.mpt_issuance_id === 'string' ? { issuanceId: meta.mpt_issuance_id } : {}) };
          this.store.set(`tx:${key}`, job);
          console.log(`${key}: ${job.receipt.code} ${job.hash}`);
        } catch (cause) { throw new UnresolvedTransaction(job.hash, { cause }); }
      }
      if (job.receipt.code !== 'tesSUCCESS') throw new LedgerFailure(job.receipt);
      return job.receipt;
    });
  }
  receipts() { return this.store.entries<Journal>('tx:').flatMap(([key, j]) => j.receipt ? [{ operationId: key.slice(3), transaction: JSON.parse(j.intent) as Transaction, ...j.receipt }] : []); }
}
