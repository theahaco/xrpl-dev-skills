import { Client, Wallet, type SubmittableTransaction, type TransactionMetadata } from 'xrpl';
import { Store } from './store.js';
export interface Signer {
  readonly address: string;
  sign(transaction: SubmittableTransaction): Promise<{ tx_blob: string; hash: string }>;
}
export function walletSigner(wallet: Wallet): Signer {
  return { address: wallet.classicAddress, sign: async tx => wallet.sign(tx) };
}
export interface Receipt { hash: string; ledgerIndex: number; code: string; meta: TransactionMetadata }
interface Pending { intent: string; blob: string; hash: string; receipt?: Receipt }
export class LedgerFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`${receipt.code}: ${receipt.hash}`); }
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn); this.tail = next.catch(() => undefined); return next;
  }
}
/** A key is permanently bound to one intent. Persist signed bytes before sending. */
export class Transactions {
  private readonly serial = new Serial();
  /** Shared by issuer instances to serialize multi-transaction compliance operations. */
  readonly complianceSerial = new Serial();
  constructor(readonly client: Client, readonly store: Store) {}
  /** Read a completed outcome without executing it, with the same intent binding. */
  completed(key: string, tx: SubmittableTransaction): Receipt | undefined {
    const saved = this.store.get<Pending>(`tx:${key}`);
    if (saved && saved.intent !== JSON.stringify(tx)) throw new Error(`Operation id reused with different intent: ${key}`);
    return saved?.receipt ? this.accept(saved.receipt) : undefined;
  }
  async checkTestnet(): Promise<void> {
    const info = (await this.client.request({ command: 'server_info' })).result.info;
    if (info.network_id !== 1) throw new Error('Refusing to sign outside XRPL testnet (network_id 1)');
  }
  submit(key: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt> {
    return this.serial.run(async () => {
      if (!key.trim()) throw new Error('An operation id is required');
      if (tx.Account !== signer.address) throw new Error('Signer/account mismatch');
      await this.checkTestnet();
      const intent = JSON.stringify(tx);
      let saved = this.store.get<Pending>(`tx:${key}`);
      if (saved && saved.intent !== intent) throw new Error(`Operation id reused with different intent: ${key}`);
      if (saved?.receipt) {
        if (this.store.get('unresolved') === key) this.store.set('unresolved', null);
        return this.accept(saved.receipt);
      }
      const unresolved = this.store.get<string | null>('unresolved');
      if (unresolved && unresolved !== key) throw new Error(`Resolve pending operation ${unresolved} before submitting ${key}`);
      if (!saved) {
        const prepared = await this.client.autofill(tx);
        if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 1000n) throw new Error('Missing expiry or fee exceeds 1000 drops');
        const signed = await signer.sign(prepared);
        saved = { intent, blob: signed.tx_blob, hash: signed.hash };
        this.store.atomic(() => {
          this.store.set(`tx:${key}`, saved);
          this.store.set('unresolved', key);
        });
      }
      this.store.set('unresolved', key);
      let receipt: Receipt | undefined;
      try {
        const prior = await this.client.request({ command: 'tx', transaction: saved.hash });
        if (prior.result.validated && typeof prior.result.ledger_index === 'number' && typeof prior.result.meta === 'object') receipt = { hash: saved.hash, ledgerIndex: prior.result.ledger_index, code: prior.result.meta.TransactionResult, meta: prior.result.meta };
      } catch (error) {
        if (!(error instanceof Error && 'data' in error && (error.data as {error?: string}).error === 'txnNotFound')) throw error;
      }
      if (!receipt) {
        const { result } = await this.client.submitAndWait(saved.blob);
        if (!result.validated || typeof result.ledger_index !== 'number' || typeof result.meta !== 'object') throw new Error(`Uncertain transaction outcome: ${saved.hash}`);
        receipt = { hash: saved.hash, ledgerIndex: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta };
      }
      this.store.atomic(() => {
        this.store.set(`tx:${key}`, { ...saved, receipt });
        this.store.set('unresolved', null);
      });
      console.log(`${key}: ${receipt.code} ${receipt.hash}`);
      return this.accept(receipt);
    });
  }
  private accept(receipt: Receipt): Receipt {
    if (receipt.code !== 'tesSUCCESS') throw new LedgerFailure(receipt);
    return receipt;
  }
}
