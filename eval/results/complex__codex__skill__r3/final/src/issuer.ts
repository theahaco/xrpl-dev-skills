import {
  Client, isValidClassicAddress, MPTokenIssuanceCreateFlags as CreateFlags,
  MPTokenAuthorizeFlags, MPTokenIssuanceSetFlags,
  type MPTokenIssuanceCreate, type Payment,
} from 'xrpl';
import { SerialQueue, type Store } from './store.js';
import type { Submitter, Receipt } from './transactions.js';
import { LedgerFailure } from './transactions.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';

export const MAX_AMOUNT = '9223372036854775807';
export const ISSUANCE_FLAGS = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
  CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export function amount(value: string): string {
  if (typeof value !== 'string' || value.length > 19 || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_AMOUNT)) throw new Error('Amount must be a positive integer string within MPT range');
  return value;
}
export function address(value: string): string {
  if (!isValidClassicAddress(value)) throw new Error('Invalid classic address');
  return value;
}
export function issuanceId(value: string): string {
  if (!/^[A-F0-9]{48}$/.test(value)) throw new Error('Invalid MPT issuance ID');
  return value;
}
export function createIssuanceTx(issuer: string, maximumAmount: string): MPTokenIssuanceCreate {
  return { TransactionType: 'MPTokenIssuanceCreate', Account: address(issuer), Flags: ISSUANCE_FLAGS,
    AssetScale: 0, MaximumAmount: amount(maximumAmount) };
}
export function paymentTx(id: string, from: string, to: string, value: string): Payment {
  return { TransactionType: 'Payment', Account: address(from), Destination: address(to),
    Amount: { mpt_issuance_id: issuanceId(id), value: amount(value) } };
}
export interface LedgerReader {
  issuance(id: string, ledger?: number): Promise<MPTokenIssuance>;
  holding(id: string, holder: string, ledger?: number): Promise<MPToken | undefined>;
}
export class XrplLedgerReader implements LedgerReader {
  constructor(private readonly client: Client) {}
  async issuance(id: string, ledger?: number): Promise<MPTokenIssuance> {
    const response = await this.client.request({ command: 'ledger_entry', mpt_issuance: issuanceId(id), ledger_index: ledger ?? 'validated' });
    if (!response.result.validated || response.result.node.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Invalid issuance response');
    return response.result.node;
  }
  async holding(id: string, holder: string, ledger?: number): Promise<MPToken | undefined> {
    try {
      const response = await this.client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: issuanceId(id), account: address(holder) }, ledger_index: ledger ?? 'validated' });
      // xrpl's LedgerEntry union omits MPToken, despite supporting the RPC selector.
      const node = response.result.node as unknown as MPToken;
      if (!response.result.validated || node.LedgerEntryType !== 'MPToken' || node.MPTokenIssuanceID !== id) throw new Error('Invalid holding response');
      return node;
    } catch (error) {
      if ((error as { data?: { error?: string } }).data?.error === 'entryNotFound') return undefined;
      throw error;
    }
  }
}
interface Ban { status: 'pending' | 'complete'; operation: string; reason: string; drainStarted?: boolean }

/** Native MPT locks exempt payments involving the issuer. They are NOT an absolute movement halt. */
export class MptIssuer {
  private readonly queue = new SerialQueue();
  constructor(readonly id: string, private readonly runner: Submitter, private readonly ledger: LedgerReader, private readonly store: Store) { issuanceId(id); }
  static async create(runner: Submitter, ledger: LedgerReader, store: Store, key: string, maximumAmount = '1000000000'): Promise<MptIssuer> {
    const receipt = await runner.execute(key, createIssuanceTx(runner.address, maximumAmount));
    if (!receipt.issuanceId) throw new Error(`Missing issuance ID in validated metadata: ${receipt.hash}`);
    const issuer = new MptIssuer(receipt.issuanceId, runner, ledger, store);
    await issuer.checkCapabilities();
    return issuer;
  }
  async checkCapabilities(): Promise<void> {
    const state = await this.ledger.issuance(this.id);
    if (state.Issuer !== this.runner.address || (state.Flags & ISSUANCE_FLAGS) !== ISSUANCE_FLAGS ||
      (state.Flags & (8 | 16 | 128)) !== 0 || state.DomainID) throw new Error('Unsupported issuer or compliance capabilities');
  }
  private holder(holder: string): string {
    address(holder);
    if (holder === this.runner.address) throw new Error('Issuer cannot be a holder');
    return holder;
  }
  private banKey(holder: string): string { return `ban:${this.id}:${this.holder(holder)}`; }
  private async assertNotBanned(holder: string): Promise<void> {
    if (await this.store.get<Ban>(this.banKey(holder))) throw new Error('Holder is banned');
  }
  approve(holder: string, key: string): Promise<Receipt> {
    return this.queue.run(async () => {
      await this.checkCapabilities();
      await this.assertNotBanned(holder);
      return this.runner.execute(key, { TransactionType: 'MPTokenAuthorize', Account: this.runner.address, MPTokenIssuanceID: this.id, Holder: holder });
    });
  }
  mint(holder: string, value: string, key: string): Promise<Receipt> {
    amount(value);
    return this.queue.run(async () => {
      await this.checkCapabilities();
      await this.assertNotBanned(holder);
      const issuance = await this.ledger.issuance(this.id);
      const holding = await this.ledger.holding(this.id, holder);
      if ((issuance.Flags & 1) !== 0 || ((holding?.Flags ?? 0) & 1) !== 0) throw new Error('Mint blocked: issuance or holder is frozen');
      if (((holding?.Flags ?? 0) & 2) === 0) throw new Error('Mint blocked: holder is not authorized');
      return this.runner.execute(key, paymentTx(this.id, this.runner.address, holder, value));
    });
  }
  clawback(holder: string, value: string, key: string): Promise<Receipt> {
    this.holder(holder); amount(value);
    return this.queue.run(async () => { await this.checkCapabilities(); return this.clawbackTx(holder, value, key); });
  }
  private clawbackTx(holder: string, value: string, key: string): Promise<Receipt> {
    return this.runner.execute(key, { TransactionType: 'Clawback', Account: this.runner.address, Holder: holder,
      Amount: { mpt_issuance_id: this.id, value } });
  }
  freezeHolder(holder: string, key: string): Promise<Receipt> { return this.lock(true, key, this.holder(holder)); }
  unfreezeHolder(holder: string, key: string): Promise<Receipt> { return this.lock(false, key, this.holder(holder)); }
  freezeGlobal(key: string): Promise<Receipt> { return this.lock(true, key); }
  unfreezeGlobal(key: string): Promise<Receipt> { return this.lock(false, key); }
  private lock(locked: boolean, key: string, holder?: string): Promise<Receipt> {
    return this.queue.run(async () => {
      await this.checkCapabilities();
      if (holder && !locked) await this.assertNotBanned(holder);
      return this.lockTx(locked, key, holder);
    });
  }
  private lockTx(locked: boolean, key: string, holder?: string): Promise<Receipt> {
    return this.runner.execute(key, { TransactionType: 'MPTokenIssuanceSet', Account: this.runner.address,
      MPTokenIssuanceID: this.id, Flags: locked ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
      ...(holder ? { Holder: holder } : {}) });
  }
  /** Resumable saga: durable ban -> revoke permission -> lock -> drain -> verify.
   * Revocation validates BEFORE draining so new receipts cannot race the drain.
   * Pending bans block approval/unlock/mint even after a crash. No unban API.
   */
  ban(holder: string, key: string, reason: string): Promise<void> {
    const storeKey = this.banKey(holder);
    if (!key || !reason.trim()) throw new Error('Ban requires operation key and audit reason');
    return this.queue.run(async () => {
      await this.checkCapabilities();
      const prior = await this.store.get<Ban>(storeKey);
      const ban: Ban = prior ?? { status: 'pending', operation: key, reason };
      await this.store.put(storeKey, ban);
      const holding = await this.ledger.holding(this.id, holder);
      if (holding) {
        await this.runner.execute(`${ban.operation}:revoke`, { TransactionType: 'MPTokenAuthorize', Account: this.runner.address,
          MPTokenIssuanceID: this.id, Holder: holder, Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize });
        await this.lockTx(true, `${ban.operation}:lock`, holder);
        const current = await this.ledger.holding(this.id, holder);
        if (ban.drainStarted || BigInt(current?.MPTAmount ?? '0') > 0n) {
          ban.drainStarted = true;
          await this.store.put(storeKey, ban);
          try { await this.clawbackTx(holder, MAX_AMOUNT, `${ban.operation}:drain`); }
          catch (error) {
            // A holder can redeem while locked; accept an empty balance only after
            // the clawback has a definitive validated result and postconditions pass.
            if (!(error instanceof LedgerFailure) || error.receipt.code !== 'tecNO_LINE') throw error;
          }
        }
      }
      const final = await this.ledger.holding(this.id, holder);
      if (BigInt(final?.MPTAmount ?? '0') !== 0n || ((final?.Flags ?? 0) & 2) !== 0) throw new Error('Ban postcondition failed; resume ban');
      await this.store.put(storeKey, { ...ban, status: 'complete' });
    });
  }
}
