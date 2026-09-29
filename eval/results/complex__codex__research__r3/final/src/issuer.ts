import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import {
  isValidClassicAddress, MPTokenIssuanceCreateFlags as CreateFlags,
  MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags as AuthFlags,
  type Payment, type MPTokenAuthorize, type LedgerEntryRequest, type LedgerEntryResponse, type SubmittableTransaction,
} from 'xrpl';
import { Ledger, rpcError, type Signer } from './ledger.js';
export { Ledger, TESTNET, checkTestnet, TransactionFailure, UncertainTransaction } from './ledger.js';
export { Store } from './store.js';
export type { Signer } from './ledger.js';
export const MAX_AMOUNT = '9223372036854775807';
export const ISSUANCE_FLAGS = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
  CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export function amount(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 19 || BigInt(value) > BigInt(MAX_AMOUNT)) {
    throw new Error('Amount must be a positive integer string no greater than 2^63-1');
  }
  return value;
}
export function address(value: string): string {
  if (!isValidClassicAddress(value)) throw new Error('Expected a classic XRPL address');
  return value;
}
export function issuanceId(value: string): string {
  if (!/^[A-F0-9]{48}$/.test(value)) throw new Error('Expected a 48-character uppercase MPT issuance ID');
  return value;
}
export function optIn(holder: string, id: string): MPTokenAuthorize {
  return { TransactionType: 'MPTokenAuthorize', Account: address(holder), MPTokenIssuanceID: issuanceId(id) };
}
export function payment(sender: string, destination: string, id: string, value: string): Payment {
  return { TransactionType: 'Payment', Account: address(sender), Destination: address(destination),
    Amount: { mpt_issuance_id: issuanceId(id), value: amount(value) } };
}

/** Native XRPL MPT controls. Locks permit redemption to issuer; see README. */
export class MptIssuer {
  private constructor(readonly ledger: Ledger, private readonly signer: Signer, readonly id: string) {}
  static async create(ledger: Ledger, signer: Signer, operationKey: string): Promise<MptIssuer> {
    const receipt = await ledger.exclusive(() => ledger.submit(operationKey, signer, {
      TransactionType: 'MPTokenIssuanceCreate', Account: address(signer.address),
      Flags: ISSUANCE_FLAGS, AssetScale: 0, MaximumAmount: MAX_AMOUNT,
    }));
    if (!receipt.issuanceId) throw new Error('Validated creation metadata did not contain mpt_issuance_id');
    return MptIssuer.attach(ledger, signer, receipt.issuanceId);
  }
  static async attach(ledger: Ledger, signer: Signer, id: string): Promise<MptIssuer> {
    const issuer = new MptIssuer(ledger, signer, issuanceId(id));
    const state = await issuer.issuance();
    if (state.Issuer !== signer.address || (state.Flags & ~1) !== ISSUANCE_FLAGS ||
        (state.AssetScale ?? 0) !== 0 || state.DomainID || state.TransferFee || state.LockedAmount && state.LockedAmount !== '0') {
      throw new Error('Issuance does not match the supported compliance configuration');
    }
    return issuer;
  }
  async issuance(ledgerIndex: number | 'validated' = 'validated'): Promise<MPTokenIssuance> {
    const response = await this.ledger.client.request({ command: 'ledger_entry', mpt_issuance: this.id, ledger_index: ledgerIndex });
    const node = response.result.node;
    if (!response.result.validated || node?.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Missing validated issuance');
    // rippled omits default-valued fields, despite the SDK declaring these required.
    return { ...node, OutstandingAmount: node.OutstandingAmount ?? '0' };
  }
  async holding(holder: string, ledgerIndex: number | 'validated' = 'validated'): Promise<MPToken | undefined> {
    try {
      const response = await this.ledger.client.request<LedgerEntryRequest, 2, LedgerEntryResponse<MPToken>>({ command: 'ledger_entry',
        mptoken: { mpt_issuance_id: this.id, account: address(holder) }, ledger_index: ledgerIndex });
      if (!response.result.validated || response.result.node?.LedgerEntryType !== 'MPToken') throw new Error('Invalid holder response');
      return { ...response.result.node, MPTAmount: response.result.node.MPTAmount ?? '0' };
    } catch (error) { if (rpcError(error, 'entryNotFound')) return undefined; throw error; }
  }
  private holder(value: string): string {
    if (address(value) === this.signer.address) throw new Error('Issuer cannot be a holder');
    return value;
  }
  private assertNotBanned(holder: string): void {
    if (this.ledger.store.isBanned(this.id, holder)) throw new Error('Address is permanently banned by issuer policy');
  }
  /** Holder must first submit optIn(). kycReference is an opaque internal reference, never PII. */
  approve(holder: string, kycReference: string, key: string) {
    this.holder(holder);
    if (!kycReference.trim() || Buffer.byteLength(kycReference) > 128) throw new Error('KYC approval reference must be 1–128 bytes');
    return this.ledger.exclusive(async () => {
      this.assertNotBanned(holder);
      return this.ledger.submit(key, this.signer, {
        TransactionType: 'MPTokenAuthorize', Account: this.signer.address,
        MPTokenIssuanceID: this.id, Holder: holder,
        Memos: [{ Memo: { MemoData: Buffer.from(kycReference).toString('hex').toUpperCase() } }],
      });
    });
  }
  issue(holder: string, value: string, key: string) {
    this.holder(holder); amount(value);
    return this.ledger.exclusive(async () => {
      this.assertNotBanned(holder);
      if (!this.ledger.store.get(key)) {
        const at = await this.ledger.client.getLedgerIndex();
        const [issuance, holding] = await Promise.all([this.issuance(at), this.holding(holder, at)]);
        if ((issuance.Flags & 1) || (holding && (holding.Flags & 1))) throw new Error('Issuance blocked by freeze policy');
        if (!holding || !(holding.Flags & 2)) throw new Error('Holder is not approved');
      }
      return this.ledger.submit(key, this.signer, payment(this.signer.address, holder, this.id, value));
    });
  }
  clawback(holder: string, value: string, key: string) {
    this.holder(holder); amount(value);
    return this.ledger.exclusive(() => this.clawbackInternal(holder, value, key));
  }
  private clawbackInternal(holder: string, value: string, key: string) {
    return this.ledger.submit(key, this.signer, { TransactionType: 'Clawback', Account: this.signer.address,
      Holder: holder, Amount: { mpt_issuance_id: this.id, value } });
  }
  setHolderFreeze(holder: string, frozen: boolean, key: string) {
    this.holder(holder);
    return this.ledger.exclusive(async () => {
      if (!frozen) this.assertNotBanned(holder);
      return this.lock(holder, frozen, key);
    });
  }
  setGlobalFreeze(frozen: boolean, key: string) {
    return this.ledger.exclusive(() => this.lock(undefined, frozen, key));
  }
  private lock(holder: string | undefined, frozen: boolean, key: string) {
    return this.ledger.submit(key, this.signer, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.address,
      MPTokenIssuanceID: this.id, Flags: frozen ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock,
      ...(holder ? { Holder: holder } : {}) });
  }
  /** Resumable, not atomic: return only after validated zero balance and authorization removal.
   * The persistent tombstone is written first. Re-run ban() after any interruption.
   * Lock stops peer movement; revocation survives holder deletion/recreation of its MPToken.
   */
  ban(holder: string, reason: string): Promise<void> {
    this.holder(holder);
    return this.ledger.exclusive(async () => {
      this.ledger.store.ban(this.id, holder, reason);
      const prefix = `ban:${this.id}:${holder}`;
      const pending = this.ledger.store.pending(this.signer.address);
      if (pending?.key.startsWith(prefix + ':')) {
        await this.ledger.submit(pending.key, this.signer, JSON.parse(pending.intent) as SubmittableTransaction);
      }
      let state = await this.holding(holder);
      if (state) {
        if (!(state.Flags & 1)) await this.lock(holder, true, `${prefix}:lock`);
        state = await this.holding(holder);
        if (state && (state.Flags & 2)) await this.ledger.submit(`${prefix}:revoke`, this.signer, {
          TransactionType: 'MPTokenAuthorize', Account: this.signer.address,
          MPTokenIssuanceID: this.id, Holder: holder, Flags: AuthFlags.tfMPTUnauthorize,
        });
        state = await this.holding(holder);
        if (state && BigInt(state.MPTAmount) > 0n) await this.clawbackInternal(holder, MAX_AMOUNT, `${prefix}:clawback`);
      }
      state = await this.holding(holder);
      if (state && (state.MPTAmount !== '0' || (state.Flags & 2))) throw new Error('Ban incomplete: retry ban()');
    });
  }
}
