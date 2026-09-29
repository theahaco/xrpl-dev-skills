import { createHash } from 'node:crypto';
import {
  Client, isValidClassicAddress, MPTokenIssuanceCreateFlags as CreateFlags,
  MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags as AuthFlags,
  type SubmittableTransaction, type Wallet, type LedgerEntry,
} from 'xrpl';
type MPToken = LedgerEntry.MPToken;
type MPTokenIssuance = LedgerEntry.MPTokenIssuance;
import type { Store, Receipt, JournalEntry } from './store.js';

export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export const MAX_AMOUNT = '9223372036854775807';
export const CAPABILITIES = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
  CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export const REQUIRED_AMENDMENTS = {
  MPTokensV1: '950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38',
  Clawback: '56B241D7A43D40354D02A9DC4C8DF5C7A1F930D92A9035C4E12291B3CA3E1C2B',
};
export function amount(value: string): string {
  if (typeof value !== 'string' || value.length > 19 || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_AMOUNT)) {
    throw new Error('Amount must be a positive canonical integer string, at most 2^63-1');
  }
  return value;
}
export function issuanceId(value: string): string {
  if (!/^[A-Fa-f0-9]{48}$/.test(value)) throw new Error('Invalid MPT issuance ID');
  return value.toUpperCase();
}
export function address(value: string): string {
  if (!isValidClassicAddress(value)) throw new Error('Invalid classic address');
  return value;
}
export interface Signer {
  address: string;
  sign(tx: SubmittableTransaction): Promise<{ tx_blob: string; hash: string }>;
}
export function walletSigner(wallet: Wallet): Signer {
  return { address: wallet.classicAddress, sign: async tx => wallet.sign(tx) };
}
export class LedgerFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`${receipt.code}: ${receipt.hash}`); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** One runner for ALL transactions from the issuer account; no parallel external signers.
 * Signed transactions are persisted before broadcast. Reusing an operation ID resumes
 * the identical signed transaction, never a fresh payment/clawback.
 */
export class TransactionRunner {
  private tail: Promise<unknown> = Promise.resolve();
  private uncertain = false;
  constructor(readonly client: Client, readonly store: Store) {}
  async checkNetwork(): Promise<void> {
    const info = await this.client.request({ command: 'server_info' });
    if (info.result.info.network_id !== 1) throw new Error('Refusing non-testnet network (expected network_id 1)');
    const response = await this.client.request({ command: 'feature' });
    const features = response.result.features;
    for (const [name, id] of Object.entries(REQUIRED_AMENDMENTS)) {
      if (!features?.[id]?.enabled) throw new Error(`Required amendment disabled: ${name}`);
    }
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async submit(key: string, tx: SubmittableTransaction, signer: Signer): Promise<Receipt> {
    if (!key || key.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid operation ID');
    if (tx.Account !== signer.address) throw new Error('Signer/account mismatch');
    const fingerprint = createHash('sha256').update(canonical(tx)).digest('hex');
    let entry = this.store.state.transactions[key];
    if (entry && entry.fingerprint !== fingerprint) throw new Error(`Operation ID reused with different input: ${key}`);
    if (entry?.receipt) return this.success(entry.receipt);
    if (this.uncertain) throw new Error('Runner halted after uncertain submission; restart and reconcile the journal');
    await this.checkNetwork();
    if (!entry) {
      const unresolved = Object.entries(this.store.state.transactions).find(([, e]) => !e.receipt);
      if (unresolved) throw new Error(`Unresolved operation ${unresolved[0]}; resume it before submitting anything new`);
      const prepared = await this.client.autofill(tx);
      if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 10000n) {
        throw new Error('Missing expiry or fee exceeds 0.01 XRP ceiling');
      }
      const signed = await signer.sign(prepared);
      entry = { fingerprint, blob: signed.tx_blob, hash: signed.hash, lastLedgerSequence: prepared.LastLedgerSequence };
      this.store.state.transactions[key] = entry;
      try { await this.store.save(); }
      catch (error) { this.uncertain = true; throw error; }
    }
    try {
      // First reconcile by hash, including when the original response was lost.
      try {
        const existing = await this.client.request({ command: 'tx', transaction: entry.hash });
        if (existing.result.validated) return await this.record(entry, existing.result);
      } catch (error) {
        if (!(error instanceof Error && 'data' in error &&
          (error.data as { error?: string } | undefined)?.error === 'txnNotFound')) throw error;
      }
      if (await this.client.getLedgerIndex() > entry.lastLedgerSequence) {
        throw new Error(`Expired unresolved transaction ${entry.hash}; reconcile full ledger history before clearing journal`);
      }
      const result = await this.client.submitAndWait(entry.blob);
      if (!result.result.validated) throw new Error('Submission not validated');
      return await this.record(entry, result.result);
    } catch (error) {
      if (!(error instanceof LedgerFailure)) this.uncertain = true;
      throw error;
    }
  }
  private async record(entry: JournalEntry, result: { hash: string; ledger_index?: number; meta?: unknown }): Promise<Receipt> {
    if (result.hash !== entry.hash) throw new Error('Transaction hash mismatch');
    if (typeof result.ledger_index !== 'number') throw new Error('Missing validated ledger index');
    if (!result.meta || typeof result.meta !== 'object' || !('TransactionResult' in result.meta) ||
        typeof result.meta.TransactionResult !== 'string') throw new Error('Missing transaction metadata');
    const receipt: Receipt = { hash: result.hash, ledgerIndex: result.ledger_index, code: result.meta.TransactionResult };
    if ('mpt_issuance_id' in result.meta && typeof result.meta.mpt_issuance_id === 'string') {
      receipt.issuanceId = issuanceId(result.meta.mpt_issuance_id);
    }
    entry.receipt = receipt;
    await this.store.save();
    return this.success(receipt);
  }
  private success(receipt: Receipt): Receipt {
    if (receipt.code !== 'tesSUCCESS') throw new LedgerFailure(receipt);
    return receipt;
  }
}

export class MptIssuer {
  constructor(readonly runner: TransactionRunner, readonly signer: Signer, readonly id: string) {
    address(signer.address); this.id = issuanceId(id);
  }
  static async create(runner: TransactionRunner, signer: Signer, operationId: string): Promise<MptIssuer> {
    return runner.exclusive(async () => {
      const receipt = await runner.submit(operationId, {
        TransactionType: 'MPTokenIssuanceCreate', Account: signer.address,
        Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: MAX_AMOUNT,
      }, signer);
      if (!receipt.issuanceId) throw new Error('Validated creation did not return mpt_issuance_id');
      const issuer = new MptIssuer(runner, signer, receipt.issuanceId);
      await issuer.assertConfiguration();
      return issuer;
    });
  }
  async issuance(ledger: number | 'validated' = 'validated'): Promise<MPTokenIssuance> {
    const response = await this.runner.client.request({ command: 'ledger_entry', mpt_issuance: this.id, ledger_index: ledger });
    if (!response.result.validated || response.result.node.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Invalid issuance response');
    return response.result.node;
  }
  async holder(holder: string, ledger: number | 'validated' = 'validated'): Promise<MPToken | undefined> {
    address(holder);
    try {
      const response = await this.runner.client.request({ command: 'ledger_entry',
        mptoken: { account: holder, mpt_issuance_id: this.id }, ledger_index: ledger });
      // xrpl 5.3.0 accidentally omits MPToken from its LedgerEntry union.
      const node: unknown = response.result.node;
      if (!response.result.validated || !node || typeof node !== 'object' ||
          !('LedgerEntryType' in node) || node.LedgerEntryType !== 'MPToken' ||
          ('MPTAmount' in node && (typeof node.MPTAmount !== 'string' || !/^[0-9]+$/.test(node.MPTAmount))) ||
          !('Flags' in node) || typeof node.Flags !== 'number') throw new Error('Invalid holder response');
      // rippled omits the default zero amount even though the SDK marks it required.
      return { ...node, MPTAmount: 'MPTAmount' in node ? node.MPTAmount : '0' } as MPToken;
    } catch (error) {
      if (error instanceof Error && 'data' in error &&
          (error.data as { error?: string } | undefined)?.error === 'entryNotFound') return undefined;
      throw error;
    }
  }
  async assertConfiguration(): Promise<void> {
    const node = await this.issuance();
    if (node.Issuer !== this.signer.address || (node.Flags & ~1) !== CAPABILITIES || node.DomainID ||
        (node.AssetScale ?? 0) !== 0 || (node.TransferFee ?? 0) !== 0) {
      throw new Error('Issuance differs from the supported compliance configuration');
    }
  }
  private banKey(holder: string): string { return `${this.id}:${address(holder)}`; }
  private checkHolder(holder: string, allowBanned = false): void {
    address(holder);
    if (holder === this.signer.address) throw new Error('Issuer cannot be a holder');
    if (!allowBanned && this.runner.store.state.bans[this.banKey(holder)]) throw new Error('Address is permanently banned');
  }
  approve(key: string, holder: string): Promise<Receipt> {
    return this.runner.exclusive(async () => {
      this.checkHolder(holder, Boolean(this.runner.store.state.transactions[key])); await this.assertConfiguration();
      return this.runner.submit(key, { TransactionType: 'MPTokenAuthorize', Account: this.signer.address,
        MPTokenIssuanceID: this.id, Holder: holder }, this.signer);
    });
  }
  issue(key: string, holder: string, value: string): Promise<Receipt> {
    return this.runner.exclusive(async () => {
      const replay = Boolean(this.runner.store.state.transactions[key]);
      this.checkHolder(holder, replay); await this.assertConfiguration();
      if (!replay) {
        const [issuance, holding] = await Promise.all([this.issuance(), this.holder(holder)]);
        if ((issuance.Flags & 1) !== 0 || ((holding?.Flags ?? 0) & 1) !== 0) throw new Error('Token or holder is frozen');
        if (!holding || (holding.Flags & 2) === 0) throw new Error('Holder is not approved');
      }
      return this.runner.submit(key, { TransactionType: 'Payment', Account: this.signer.address,
        Destination: holder, Amount: { mpt_issuance_id: this.id, value: amount(value) } }, this.signer);
    });
  }
  clawback(key: string, holder: string, value: string): Promise<Receipt> {
    return this.runner.exclusive(async () => {
      this.checkHolder(holder, true); await this.assertConfiguration();
      return this.runner.submit(key, { TransactionType: 'Clawback', Account: this.signer.address,
        Holder: holder, Amount: { mpt_issuance_id: this.id, value: amount(value) } }, this.signer);
    });
  }
  /** Native MPT lock: issuer redemption and clawback are protocol exceptions. */
  freeze(key: string, holder: string, frozen: boolean): Promise<Receipt> {
    return this.runner.exclusive(async () => {
      this.checkHolder(holder, frozen || Boolean(this.runner.store.state.transactions[key])); await this.assertConfiguration();
      return this.setLock(key, frozen, holder);
    });
  }
  /** Native global lock; does not override the protocol's issuer-redemption exception. */
  globalFreeze(key: string, frozen: boolean): Promise<Receipt> {
    return this.runner.exclusive(async () => {
      await this.assertConfiguration(); return this.setLock(key, frozen);
    });
  }
  private setLock(key: string, frozen: boolean, holder?: string): Promise<Receipt> {
    return this.runner.submit(key, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.address,
      MPTokenIssuanceID: this.id, Flags: frozen ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock,
      ...(holder ? { Holder: holder } : {}) }, this.signer);
  }
  /** Retry the SAME key after an interruption. Persist intent before any ledger effects.
   * No rollback to approval on error. A ban is complete only after the final ledger check.
   */
  ban(key: string, holder: string, reason: string): Promise<void> {
    return this.runner.exclusive(async () => {
      this.checkHolder(holder, true); await this.assertConfiguration();
      if (!reason.trim()) throw new Error('Ban requires an audit reason');
      this.runner.store.state.bans[this.banKey(holder)] ??= { reason, requestedAt: new Date().toISOString() };
      await this.runner.store.save();
      let node = await this.holder(holder);
      if (!node) return; // A future opt-in is still unauthorized; local ban prevents approval.
      await this.setLock(`${key}:lock`, true, holder);
      await this.runner.submit(`${key}:revoke`, { TransactionType: 'MPTokenAuthorize',
        Account: this.signer.address, MPTokenIssuanceID: this.id, Holder: holder,
        Flags: AuthFlags.tfMPTUnauthorize }, this.signer);
      node = await this.holder(holder);
      // MAX_AMOUNT ensures a racing incoming transfer cannot leave a residual balance.
      if (node && BigInt(node.MPTAmount) > 0n) {
        try {
          await this.runner.submit(`${key}:clawback`, { TransactionType: 'Clawback', Account: this.signer.address,
            Holder: holder, Amount: { mpt_issuance_id: this.id, value: MAX_AMOUNT } }, this.signer);
        } catch (error) {
          if (!(error instanceof LedgerFailure && error.receipt.code === 'tecNO_LINE')) throw error;
        }
      }
      node = await this.holder(holder);
      if (node && (BigInt(node.MPTAmount) !== 0n || (node.Flags & 2) !== 0)) throw new Error('Ban incomplete; retry the same operation ID');
    });
  }
}
