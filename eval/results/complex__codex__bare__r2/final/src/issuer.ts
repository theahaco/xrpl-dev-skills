import { isValidClassicAddress, convertStringToHex, MPTokenIssuanceCreateFlags as Create, type SubmittableTransaction } from 'xrpl';
import { LedgerFailure, type LedgerPort, type Receipt } from './ledger.js';
import type { BanStore } from './storage.js';

export const MAX_AMOUNT = (2n ** 63n - 1n).toString();
export const REQUIRED_FLAGS = Create.tfMPTCanLock | Create.tfMPTRequireAuth | Create.tfMPTCanTransfer | Create.tfMPTCanClawback;
export const LOCKED = 1;
export const AUTHORIZED = 2;
export function amount(value: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_AMOUNT)) throw new Error('Amount must be a positive integer string <= 2^63-1');
  return value;
}
export function address(value: string): string {
  if (!isValidClassicAddress(value)) throw new Error('Expected a classic XRPL address');
  return value;
}
/** Scale zero: all amounts are whole token units, represented as strings. */
export class MptIssuer {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly account: string, readonly issuanceId: string, private readonly ledger: LedgerPort, private readonly bans: BanStore) {
    address(account);
    if (!/^[A-F0-9]{48}$/.test(issuanceId)) throw new Error('Invalid issuance ID');
  }
  static async create(account: string, ledger: LedgerPort, bans: BanStore, key: string): Promise<MptIssuer> {
    address(account);
    const receipt = await ledger.send(key, {
      TransactionType: 'MPTokenIssuanceCreate', Account: account,
      AssetScale: 0, MaximumAmount: MAX_AMOUNT, Flags: REQUIRED_FLAGS,
      MPTokenMetadata: convertStringToHex(JSON.stringify({ t: 'CMP', n: 'Compliance Test Token', d: 'Testnet demo; no monetary backing', ac: 'other' })),
    });
    const meta = receipt.meta as Receipt['meta'] & { mpt_issuance_id?: string };
    let id = meta.mpt_issuance_id;
    if (!id) {
      // UInt32 sequence in big endian followed by the issuer AccountID.
      const { decodeAccountID } = await import('ripple-address-codec');
      const node = meta.AffectedNodes.find(n => 'CreatedNode' in n && n.CreatedNode.LedgerEntryType === 'MPTokenIssuance');
      if (!node || !('CreatedNode' in node)) throw new Error('Missing issuance metadata');
      const sequence = node.CreatedNode.NewFields.Sequence;
      if (typeof sequence !== 'number') throw new Error('Missing issuance sequence');
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(sequence);
      id = Buffer.concat([prefix, Buffer.from(decodeAccountID(account))]).toString('hex').toUpperCase();
    }
    const issuer = new MptIssuer(account, id, ledger, bans);
    await issuer.validate();
    return issuer;
  }
  /** Reject incompatible assets, including escrow/trading/confidential capabilities. */
  async validate(): Promise<void> {
    const entry = await this.ledger.issuance(this.issuanceId);
    if (entry.Issuer !== this.account || (entry.Flags & ~LOCKED) !== REQUIRED_FLAGS || (entry.AssetScale ?? 0) !== 0 || (entry.TransferFee ?? 0) !== 0 || entry.DomainID) {
      throw new Error('Issuance does not satisfy this module’s compliance policy');
    }
  }
  private holder(holder: string): string {
    address(holder);
    if (holder === this.account) throw new Error('Issuer is not a holder');
    return holder;
  }
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const promise = this.tail.then(async () => { await this.validate(); return fn(); });
    this.tail = promise.catch(() => undefined);
    return promise;
  }
  private async allowed(holder: string): Promise<void> {
    this.holder(holder);
    if (await this.bans.has(this.issuanceId, holder)) throw new Error('Address is permanently banned by issuer policy');
  }
  private tx(key: string, fields: SubmittableTransaction): Promise<Receipt> { return this.ledger.send(key, fields); }
  /** Call only after backend KYC approval. Holder must first opt in using MPTokenAuthorize. */
  approve(holder: string, key: string): Promise<Receipt> {
    return this.run(async () => {
      await this.allowed(holder);
      return this.tx(key, { TransactionType: 'MPTokenAuthorize', Account: this.account, MPTokenIssuanceID: this.issuanceId, Holder: holder });
    });
  }
  mint(holder: string, quantity: string, key: string): Promise<Receipt> {
    return this.run(async () => {
      await this.allowed(holder); amount(quantity);
      return this.tx(key, { TransactionType: 'Payment', Account: this.account, Destination: holder, Amount: { mpt_issuance_id: this.issuanceId, value: quantity } });
    });
  }
  clawback(holder: string, quantity: string, key: string): Promise<Receipt> {
    return this.run(async () => {
      this.holder(holder); amount(quantity);
      return this.claw(holder, quantity, key);
    });
  }
  private claw(holder: string, quantity: string, key: string): Promise<Receipt> {
    return this.tx(key, { TransactionType: 'Clawback', Account: this.account, Holder: holder, Amount: { mpt_issuance_id: this.issuanceId, value: quantity } });
  }
  private lock(holder: string | undefined, frozen: boolean, key: string): Promise<Receipt> {
    return this.tx(key, { TransactionType: 'MPTokenIssuanceSet', Account: this.account, MPTokenIssuanceID: this.issuanceId, Flags: frozen ? 1 : 2, ...(holder ? { Holder: holder } : {}) });
  }
  freeze(holder: string, key: string): Promise<Receipt> {
    return this.run(() => this.lock(this.holder(holder), true, key));
  }
  unfreeze(holder: string, key: string): Promise<Receipt> {
    return this.run(async () => { await this.allowed(holder); return this.lock(holder, false, key); });
  }
  globalFreeze(key: string): Promise<Receipt> { return this.run(() => this.lock(undefined, true, key)); }
  globalUnfreeze(key: string): Promise<Receipt> { return this.run(() => this.lock(undefined, false, key)); }
  /** Resumable saga, not atomic: persist ban, revoke authorization, drain, verify.
   * Revocation closes the inbound race. Holder redemption can only reduce the drain.
   * A ban on an account without an MPToken entry still prevents future module approval.
   */
  ban(holder: string, key: string): Promise<void> {
    return this.run(async () => {
      this.holder(holder);
      await this.bans.add(this.issuanceId, holder);
      const before = await this.ledger.holding(this.issuanceId, holder);
      if (before) {
        await this.tx(`${key}/revoke`, { TransactionType: 'MPTokenAuthorize', Account: this.account, MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: 1 });
        const revoked = await this.ledger.holding(this.issuanceId, holder);
        if (revoked && (revoked.Flags & AUTHORIZED)) throw new Error('Authorization revocation failed');
        // Use the protocol maximum: deterministic retry intent and full drain despite balance changes.
        if (revoked && BigInt(revoked.MPTAmount ?? '0') > 0n) {
          try { await this.claw(holder, MAX_AMOUNT, `${key}/drain`); }
          catch (error) {
            // A concurrent redemption may have emptied the balance. Verify below.
            if (!(error instanceof LedgerFailure) || error.receipt.code !== 'tecNO_LINE') throw error;
          }
        }
      }
      const after = await this.ledger.holding(this.issuanceId, holder);
      if (after && ((after.Flags & AUTHORIZED) || BigInt(after.MPTAmount ?? '0') !== 0n)) throw new Error('Ban incomplete; retry the same operation key');
    });
  }
}
