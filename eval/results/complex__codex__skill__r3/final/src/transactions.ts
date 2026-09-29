import { createHash } from 'node:crypto';
import { Client, xrpToDrops, type SubmittableTransaction, type Wallet, type TxResponse } from 'xrpl';
import { SerialQueue, type Receipt, type StateStore } from './state.js';

export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export interface Signer {
  readonly classicAddress: string;
  sign(transaction: SubmittableTransaction): ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
}
export class LedgerFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`${receipt.code}: ${receipt.hash}`); }
}
export function rpcError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'data' in error &&
    typeof error.data === 'object' && error.data !== null && 'error' in error.data && error.data.error === code;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** IDs are durable idempotency keys. Never replace an uncertain transaction with a new ID. */
export class TransactionRunner {
  private readonly queue = new SerialQueue();
  readonly workflows = new SerialQueue();
  private constructor(readonly client: Client, readonly store: StateStore) {}
  static async testnet(client: Client, store: StateStore): Promise<TransactionRunner> {
    const info = (await client.request({ command: 'server_info' })).result.info;
    if (info.network_id !== 1) throw new Error('Refusing non-testnet network');
    return new TransactionRunner(client, store);
  }
  async send(id: string, transaction: SubmittableTransaction, signer: Signer): Promise<Receipt> {
    return this.queue.run(async () => {
      if (!/^[a-zA-Z0-9:/._-]{1,200}$/.test(id)) throw new Error('Invalid operation ID');
      if (transaction.Account !== signer.classicAddress) throw new Error('Signer/account mismatch');
      const intent = createHash('sha256').update(canonical(transaction)).digest('hex');
      let pending = this.store.data.transactions[id];
      if (pending && pending.intent !== intent) throw new Error('Operation ID reused with different transaction');
      if (!pending) {
        // A previous uncertain outcome must be resolved before spending another sequence.
        if (Object.values(this.store.data.transactions).some(p => !p.receipt)) {
          throw new Error('Unresolved transaction in journal; resume its original operation first');
        }
        const [server, account] = await Promise.all([
          this.client.request({ command: 'server_info' }),
          this.client.request({ command: 'account_info', account: transaction.Account, ledger_index: 'validated' }),
        ]);
        if (server.result.info.network_id !== 1 || !account.result.validated) throw new Error('Unverified testnet account state');
        const reserves = server.result.info.validated_ledger;
        if (!reserves) throw new Error('Missing reserve information');
        const createsObject = transaction.TransactionType === 'MPTokenIssuanceCreate' ||
          (transaction.TransactionType === 'MPTokenAuthorize' && !transaction.Holder && transaction.Flags !== 1);
        const reserve = BigInt(xrpToDrops(reserves.reserve_base_xrp)) +
          BigInt(xrpToDrops(reserves.reserve_inc_xrp)) * BigInt(account.result.account_data.OwnerCount + (createsObject ? 1 : 0));
        const spend = transaction.TransactionType === 'Payment' && typeof transaction.Amount === 'string' ? BigInt(transaction.Amount) : 0n;
        if (BigInt(account.result.account_data.Balance) < reserve + spend + 10_000n) throw new Error('Insufficient XRP above reserves and fee budget');
        const prepared = await this.client.autofill(transaction);
        if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 10_000n) throw new Error('Missing expiry or excessive fee');
        const signed = await signer.sign(prepared);
        pending = { intent, blob: signed.tx_blob, hash: signed.hash, lastLedger: prepared.LastLedgerSequence };
        this.store.data.transactions[id] = pending;
        await this.store.save(); // Durable BEFORE broadcast.
      }
      if (!pending.receipt) {
        await this.store.save(); // Also covers a retry after a failed persistence attempt.
        let response: TxResponse | undefined;
        try { response = await this.client.request({ command: 'tx', transaction: pending.hash }); }
        catch (error) { if (!rpcError(error, 'txnNotFound')) throw error; }
        if (!response?.result.validated) {
          // xrpl.js follows terQUEUED until validation/expiry. Replays use the SAME signed blob.
          // tefPAST_SEQ is resolved via hash lookup, never by blindly re-signing a payment.
          try { response = await this.client.submitAndWait(pending.blob); }
          catch (error) {
            try { response = await this.client.request({ command: 'tx', transaction: pending.hash }); }
            catch { throw new Error(`Outcome unresolved for ${id} (${pending.hash}); reconcile original hash before retry`, { cause: error }); }
          }
        }
        if (!response) throw new Error('Missing transaction response');
        const result = response.result;
        if (!result.validated || !result.meta || typeof result.meta === 'string' || !result.ledger_index) throw new Error(`Unvalidated outcome: ${pending.hash}`);
        pending.receipt = { hash: pending.hash, ledgerIndex: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta };
        await this.store.save();
        console.log(`${id}: ${pending.receipt.code} ${pending.hash}`);
      }
      await this.store.save();
      if (pending.receipt.code !== 'tesSUCCESS') throw new LedgerFailure(pending.receipt);
      return pending.receipt;
    });
  }
}
