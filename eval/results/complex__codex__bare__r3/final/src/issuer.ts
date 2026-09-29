import { Client, Wallet, isValidClassicAddress, MPTokenIssuanceCreateFlags as F, type SubmittableTransaction } from 'xrpl';

import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';

export const MAX_AMOUNT = 9223372036854775807n;
export const CONTROL_FLAGS = F.tfMPTRequireAuth | F.tfMPTCanLock | F.tfMPTCanClawback | F.tfMPTCanTransfer;
export function amount(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > MAX_AMOUNT) throw new Error('Amount must be a positive integer string <= 2^63-1');
  return value;
}
/** rippled omits default-valued fields despite the SDK declaring MPTAmount required. */
export function normalizeHolding(node: MPToken): MPToken {
  const value = node.MPTAmount ?? '0';
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > MAX_AMOUNT) throw new Error('Invalid ledger MPT balance');
  return { ...node, MPTAmount: value };
}
export interface Receipt { hash: string; ledger: number; code: string }
export interface Journal {
  /** Persist before broadcast; a pending entry must block new submissions until reconciled. */
  prepared(hash: string, blob: string, lastLedger: number): Promise<void>;
  validated(receipt: Receipt): Promise<void>;
}
export class TransactionFailure extends Error {
  constructor(public readonly receipt: Receipt) { super(`Validated transaction ${receipt.hash}: ${receipt.code}`); }
}
/** One instance per signing account, with an exclusive external lock across processes. */
export class Submitter {
  private tail: Promise<unknown> = Promise.resolve();
  private uncertain = false;
  constructor(readonly client: Client, readonly wallet: Wallet, private readonly journal: Journal) {}
  submit(tx: SubmittableTransaction): Promise<Receipt> {
    const job = this.tail.then(async () => {
      if (this.uncertain) throw new Error('Submission outcome unresolved; reconcile journal before restarting');
      if (tx.Account !== this.wallet.classicAddress) throw new Error('Signer/account mismatch');
      const info = await this.client.request({ command: 'server_info' });
      if (info.result.info.network_id !== 1) throw new Error('Only XRPL testnet network_id=1 is permitted');
      const filled = await this.client.autofill(tx);
      if (!filled.Fee || BigInt(filled.Fee) > 1000n || !filled.LastLedgerSequence) throw new Error('Fee/expiry safety check failed');
      const signed = this.wallet.sign(filled);
      this.uncertain = true;
      await this.journal.prepared(signed.hash, signed.tx_blob, filled.LastLedgerSequence);
      const response = await this.client.submitAndWait(signed.tx_blob);
      const r = response.result;
      if (!r.ledger_index || !r.validated || !r.meta || typeof r.meta === 'string') throw new Error(`Unresolved transaction ${signed.hash}`);
      const receipt = { hash: signed.hash, ledger: r.ledger_index, code: r.meta.TransactionResult };
      await this.journal.validated(receipt);
      this.uncertain = false;
      if (receipt.code !== 'tesSUCCESS') throw new TransactionFailure(receipt);
      return receipt;
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
}
export interface BanStore {
  has(issuanceId: string, holder: string): Promise<boolean>;
  /** Durably record intent before any ledger action. No automatic unban. */
  add(issuanceId: string, holder: string): Promise<void>;
}
export class Issuer {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly submitter: Submitter, readonly issuanceId: string, private readonly bans: BanStore) {
    if (!/^[A-F0-9]{48}$/.test(issuanceId)) throw new Error('Invalid MPT issuance ID');
  }
  static async create(submitter: Submitter): Promise<string> {
    const receipt = await submitter.submit({ TransactionType: 'MPTokenIssuanceCreate', Account: submitter.wallet.classicAddress, Flags: CONTROL_FLAGS, AssetScale: 0, MaximumAmount: MAX_AMOUNT.toString() });
    const response = await submitter.client.request({ command: 'tx', transaction: receipt.hash, binary: false });
    const meta = response.result.meta;
    if (!meta || typeof meta === 'string') throw new Error('Missing issuance metadata');
    const id = (meta as typeof meta & { mpt_issuance_id?: string }).mpt_issuance_id;
    if (!id) throw new Error(`Missing issuance ID; reconcile creation ${receipt.hash}`);
    return id;
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.tail.then(fn); this.tail = job.catch(() => undefined); return job;
  }
  private holder(address: string): void {
    if (!isValidClassicAddress(address) || address === this.submitter.wallet.classicAddress) throw new Error('Invalid holder');
  }
  private async permitted(holder: string): Promise<void> {
    this.holder(holder);
    if (await this.bans.has(this.issuanceId, holder)) throw new Error('Holder is permanently banned by policy');
  }
  async issuance(ledger: number | 'validated' = 'validated'): Promise<MPTokenIssuance> {
    const r = await this.submitter.client.request({ command: 'ledger_entry', mpt_issuance: this.issuanceId, ledger_index: ledger });
    if (!r.result.validated || r.result.node.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Invalid issuance response');
    return r.result.node;
  }
  async holding(holder: string, ledger: number | 'validated' = 'validated'): Promise<MPToken | null> {
    this.holder(holder);
    try {
      const r = await this.submitter.client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: this.issuanceId, account: holder }, ledger_index: ledger });
      const node = r.result.node as unknown as MPToken;
      if (!r.result.validated || node.LedgerEntryType !== 'MPToken') throw new Error('Invalid holding response');
      return normalizeHolding(node);
    } catch (e) {
      if (e instanceof Error && 'data' in e && (e.data as {error?: string})?.error === 'entryNotFound') return null;
      throw e;
    }
  }
  async verifyConfiguration(): Promise<void> {
    const i = await this.issuance();
    if (i.Issuer !== this.submitter.wallet.classicAddress || (i.Flags & CONTROL_FLAGS) !== CONTROL_FLAGS || (i.Flags & (8 | 16 | 128)) !== 0 || (i.AssetScale ?? 0) !== 0 || (i.TransferFee ?? 0) !== 0 || i.DomainID) throw new Error('Unsupported issuance configuration');
  }
  private authorize(holder: string, revoke: boolean): Promise<Receipt> {
    return this.submitter.submit({ TransactionType: 'MPTokenAuthorize', Account: this.submitter.wallet.classicAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: revoke ? 1 : 0 });
  }
  approve(holder: string): Promise<Receipt> {
    return this.exclusive(async () => { await this.permitted(holder); await this.verifyConfiguration(); return this.authorize(holder, false); });
  }
  mint(holder: string, value: string): Promise<Receipt> {
    amount(value);
    return this.exclusive(async () => {
      await this.permitted(holder); await this.verifyConfiguration();
      const [i, h] = await Promise.all([this.issuance(), this.holding(holder)]);
      if (!h || !(h.Flags & 2) || (h.Flags & 1) || (i.Flags & 1)) throw new Error('Holder unauthorized or frozen');
      return this.submitter.submit({ TransactionType: 'Payment', Account: this.submitter.wallet.classicAddress, Destination: holder, Amount: { mpt_issuance_id: this.issuanceId, value } });
    });
  }
  private lock(frozen: boolean, holder?: string): Promise<Receipt> {
    return this.submitter.submit({ TransactionType: 'MPTokenIssuanceSet', Account: this.submitter.wallet.classicAddress, MPTokenIssuanceID: this.issuanceId, Flags: frozen ? 1 : 2, ...(holder ? { Holder: holder } : {}) });
  }
  freezeHolder(holder: string, frozen = true): Promise<Receipt> {
    return this.exclusive(async () => { this.holder(holder); if (!frozen) await this.permitted(holder); await this.verifyConfiguration(); return this.lock(frozen, holder); });
  }
  freezeAll(frozen = true): Promise<Receipt> {
    return this.exclusive(async () => { await this.verifyConfiguration(); return this.lock(frozen); });
  }
  private claw(holder: string, value: string): Promise<Receipt> {
    return this.submitter.submit({ TransactionType: 'Clawback', Account: this.submitter.wallet.classicAddress, Holder: holder, Amount: { mpt_issuance_id: this.issuanceId, value } });
  }
  /** XRPL clamps an amount exceeding the current balance to that balance. */
  clawback(holder: string, value: string): Promise<Receipt> {
    this.holder(holder); amount(value);
    return this.exclusive(async () => { await this.verifyConfiguration(); return this.claw(holder, value); });
  }
  /** Resumable, not atomic. Revocation blocks incoming funds before balance removal. */
  ban(holder: string): Promise<void> {
    this.holder(holder);
    return this.exclusive(async () => {
      await this.verifyConfiguration();
      await this.bans.add(this.issuanceId, holder);
      let h = await this.holding(holder);
      if (h && (h.Flags & 2)) await this.authorize(holder, true);
      h = await this.holding(holder);
      if (h && BigInt(h.MPTAmount) > 0n) await this.claw(holder, MAX_AMOUNT.toString());
      h = await this.holding(holder);
      if (h && (BigInt(h.MPTAmount) !== 0n || (h.Flags & 2))) throw new Error('Ban incomplete; retry ban after reconciliation');
    });
  }
}
