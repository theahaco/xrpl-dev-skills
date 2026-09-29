import { createHash } from 'node:crypto';
import { Client, type SubmittableTransaction, type LedgerEntry, type Wallet, type TxResponse, type LedgerEntryRequest } from 'xrpl';
import { Journal } from './journal.js';

export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export const AMENDMENTS = '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4';
export const REQUIRED = ['MPTokensV1', 'Clawback', 'DepositAuth', 'fixMPTDeliveredAmount'] as const;
export class LedgerFailure extends Error {
  constructor(readonly code: string, readonly hash: string) { super(`${code}: ${hash}`); }
}
export function resultCode(r: TxResponse['result']): string {
  if (r.validated !== true || typeof r.meta !== 'object' || !r.meta) throw new Error('Transaction is not validated');
  return r.meta.TransactionResult;
}
export function requireSuccess(r: TxResponse['result']): void {
  const code = resultCode(r);
  if (code !== 'tesSUCCESS') throw new LedgerFailure(code, r.hash);
}
export class Ledger {
  private tail: Promise<unknown> = Promise.resolve();
  private submissionTail: Promise<unknown> = Promise.resolve();
  constructor(readonly client: Client, readonly journal: Journal) {}
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async preflight() {
    const info = (await this.client.request({command:'server_info'})).result.info;
    if (info.network_id !== 1) throw new Error('Only XRPL testnet network_id=1 is permitted');
    const features = (await this.client.request({command:'feature'})).result.features;
    const response = await this.client.request({command:'ledger_entry',index:AMENDMENTS,ledger_index:'validated'});
    const node = response.result.node;
    if (response.result.validated !== true || node?.LedgerEntryType !== 'Amendments') throw new Error('Missing validated amendments');
    for (const name of REQUIRED) {
      const found = Object.entries(features).find(([,v]) => v.name === name);
      if (!found || !found[1].enabled || !node.Amendments?.includes(found[0])) throw new Error(`Amendment disabled: ${name}`);
    }
    return { info, features, amendments: node };
  }
  async entry(request: Omit<LedgerEntryRequest,'command'>): Promise<LedgerEntry.LedgerEntry | LedgerEntry.MPToken | undefined> {
    try {
      const response = await this.client.request({command:'ledger_entry',...(request.ledger_hash ? {} : {ledger_index:'validated' as const}),...request});
      if (response.result.validated !== true || !response.result.node) throw new Error('Unvalidated ledger entry');
      return response.result.node;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'data' in error &&
        typeof error.data === 'object' && error.data !== null && 'error' in error.data && error.data.error === 'entryNotFound') return undefined;
      throw error;
    }
  }
  /** Persist bytes before submission. Retry the SAME id/hash on ambiguous outcomes. */
  send(id: string, wallet: Wallet, tx: SubmittableTransaction): Promise<TxResponse['result']> {
    const next = this.submissionTail.then(() => this.sendOnce(id,wallet,tx));
    this.submissionTail = next.catch(() => undefined);
    return next;
  }
  private async sendOnce(id: string, wallet: Wallet, tx: SubmittableTransaction): Promise<TxResponse['result']> {
    if (!id.trim() || tx.Account !== wallet.classicAddress) throw new Error('Invalid operation id or signing account');
    const intent = createHash('sha256').update(JSON.stringify(tx)).digest('hex');
    let row = this.journal.db.prepare('SELECT * FROM tx WHERE id=?').get(id);
    if (row && row.intent !== intent) throw new Error(`Idempotency conflict: ${id}`);
    if (row?.result) return JSON.parse(String(row.result)) as TxResponse['result'];
    if (!row) {
      if (this.journal.db.prepare('SELECT id FROM tx WHERE result IS NULL').get()) throw new Error('Unresolved transaction: recover its original operation first');
      const prepared = await this.client.autofill(tx);
      if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 10000n) throw new Error('Missing expiry or fee exceeds 0.01 XRP');
      const signed = wallet.sign(prepared);
      this.journal.db.prepare('INSERT INTO tx VALUES (?,?,?,?,?,NULL)').run(id,intent,signed.tx_blob,signed.hash,prepared.LastLedgerSequence);
      row = this.journal.db.prepare('SELECT * FROM tx WHERE id=?').get(id)!;
    }
    const hash = String(row.hash);
    let result: TxResponse['result'];
    try {
      result = (await this.client.submitAndWait(String(row.blob))).result;
    } catch {
      // terQUEUED / tefPAST_SEQ / transport failures: resolve the ORIGINAL hash.
      try { result = (await this.client.request({command:'tx',transaction:hash})).result; }
      catch { throw new Error(`Unresolved ${id} (${hash}); retain journal and retry same operation. Do not recreate transaction.`); }
    }
    resultCode(result);
    if (result.hash !== hash) throw new Error('Validated response hash does not match signed transaction');
    this.journal.db.prepare('UPDATE tx SET result=? WHERE id=?').run(JSON.stringify(result),id);
    console.log(`${id}: ${resultCode(result)} ${hash}`);
    return result;
  }
}
