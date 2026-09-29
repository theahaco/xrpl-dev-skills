import { Client, type SubmittableTransaction, type TransactionMetadata } from 'xrpl';
import { createHash } from 'node:crypto';
import { SerialQueue, Store } from './store.js';

export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export interface Signer {
  readonly classicAddress: string;
  sign(tx: SubmittableTransaction): { tx_blob: string; hash: string } | Promise<{ tx_blob: string; hash: string }>;
}
export interface Receipt { hash: string; ledgerIndex: number; code: string; meta: TransactionMetadata }
interface Journal { fingerprint: string; blob: string; hash: string; lastLedger: number; receipt?: Receipt }
export class LedgerFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`${receipt.code}: ${receipt.hash}`); }
}
export class UnresolvedTransaction extends Error {
  constructor(readonly hash: string, readonly lastLedger: number, options?: ErrorOptions) {
    super(`Transaction ${hash} unresolved (LastLedgerSequence ${lastLedger}); reconcile or retry SAME operation ID. Do not create a replacement.`, options);
  }
}

export async function checkTestnet(client: Client) {
  if (client.url !== TESTNET) throw new Error('Only the configured public testnet endpoint is allowed');
  const [server, features] = await Promise.all([
    client.request({ command: 'server_info' }), client.request({ command: 'feature' }),
  ]);
  if (server.result.info.network_id !== 1 || !server.result.info.validated_ledger || server.result.info.validated_ledger.age > 30) {
    throw new Error('Expected a fresh validated testnet ledger with network ID 1');
  }
  const required = ['MPTokensV1', 'Clawback', 'fixMPTDeliveredAmount'];
  for (const name of required) {
    if (!Object.values(features.result.features).some(f => f.name === name && f.enabled && f.supported)) {
      throw new Error(`Required amendment unavailable: ${name}`);
    }
  }
  return { server: server.result.info, features: features.result.features };
}

/** Persists signed bytes BEFORE submission. Same ID + same payload never signs twice. */
export class TransactionRunner {
  private readonly queue = new SerialQueue();
  private readonly controls = new Map<string, SerialQueue>();
  constructor(readonly client: Client, readonly store: Store) {}
  control<T>(account: string, work: () => Promise<T>): Promise<T> {
    let queue = this.controls.get(account);
    if (!queue) { queue = new SerialQueue(); this.controls.set(account, queue); }
    return queue.run(work);
  }
  audit(): { operationId: string; hash: string; lastLedger: number; receipt?: Receipt }[] {
    return this.store.entries<Journal>('tx:').map(({ key, value }) => ({
      operationId: key.slice(3), hash: value.hash, lastLedger: value.lastLedger,
      ...(value.receipt ? { receipt: value.receipt } : {}),
    }));
  }
  send(id: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt> {
    return this.queue.run(async () => {
      if (!id.trim() || tx.Account !== signer.classicAddress) throw new Error('Invalid operation ID or signer account');
      const fingerprint = createHash('sha256').update(JSON.stringify(tx)).digest('hex');
      const key = `tx:${id}`;
      let entry = this.store.get<Journal>(key);
      if (entry && entry.fingerprint !== fingerprint) throw new Error(`Operation ID reused for a different payload: ${id}`);
      if (entry?.receipt) return this.success(entry.receipt);
      const pendingKey = `pending:${tx.Account}`;
      const pending = this.store.get<string | null>(pendingKey);
      if (pending && pending !== id) throw new Error(`Account has unresolved operation ${pending}; reconcile it first`);
      await checkTestnet(this.client);
      if (!entry) {
        const prepared = await this.client.autofill(tx);
        if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 10_000n) throw new Error('Missing expiry or fee exceeds 0.01 XRP');
        const signed = await signer.sign(prepared);
        entry = { fingerprint, blob: signed.tx_blob, hash: signed.hash, lastLedger: prepared.LastLedgerSequence };
        this.store.putMany([[key, entry], [pendingKey, id]]);
      }
      this.store.put(pendingKey, id);
      const record = (result: { validated?: boolean; hash: string; ledger_index?: number; meta?: unknown }): Receipt => {
        if (result.validated !== true || !result.ledger_index || typeof result.meta !== 'object' || !result.meta || !('TransactionResult' in result.meta)) {
          throw new Error('Expected validated transaction metadata');
        }
        const meta = result.meta as TransactionMetadata;
        const receipt: Receipt = { hash: result.hash, ledgerIndex: result.ledger_index, code: meta.TransactionResult, meta };
        if (result.hash !== entry?.hash) throw new Error('Transaction hash mismatch');
        this.store.putMany([[key, { ...entry, receipt }], [pendingKey, null]]);
        return receipt;
      };
      let receipt: Receipt;
      try {
        receipt = record((await this.client.submitAndWait(entry.blob)).result);
      } catch (error) {
        // Covers tefPAST_SEQ after a successful but interrupted submission, and SDK
        // errors for validated tec failures. Never rebuild a payment with a new sequence.
        try { receipt = record((await this.client.request({ command: 'tx', transaction: entry.hash })).result); }
        catch { throw new UnresolvedTransaction(entry.hash, entry.lastLedger, { cause: error }); }
      }
      console.log(`${id}: ${receipt.code} ${receipt.hash}`);
      return this.success(receipt);
    });
  }
  private success(receipt: Receipt): Receipt {
    if (receipt.code !== 'tesSUCCESS') throw new LedgerFailure(receipt);
    return receipt;
  }
}
