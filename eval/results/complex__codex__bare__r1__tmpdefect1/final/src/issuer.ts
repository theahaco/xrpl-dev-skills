import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { isValidClassicAddress, MPTokenIssuanceCreateFlags as Create, MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags as Auth, type SubmittableTransaction } from 'xrpl';
import { Transactions, LedgerFailure, type Signer, type Receipt } from './transactions.js';
export const MAX_AMOUNT = 9223372036854775807n;
export const CAPABILITIES = Create.tfMPTCanLock | Create.tfMPTRequireAuth | Create.tfMPTCanClawback | Create.tfMPTCanTransfer;
export function amount(value: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > MAX_AMOUNT) throw new Error('Amount must be a positive integer string <= 2^63-1, in base units');
  return value;
}
export function holderAddress(value: string, issuer: string): string {
  if (!isValidClassicAddress(value) || value === issuer) throw new Error('Expected a non-issuer classic holder address');
  return value;
}
export interface HolderState { balance: string; authorized: boolean; frozen: boolean; exists: boolean }
/** KYC decisions happen upstream. Only trusted compliance services may call approve. */
export class MptIssuer {
  private get serial() { return this.transactions.complianceSerial; }
  private constructor(readonly transactions: Transactions, private readonly signer: Signer, readonly issuanceId: string) {}
  static async create(transactions: Transactions, signer: Signer, operationId: string, maximumAmount = '1000000000', assetScale = 0): Promise<MptIssuer> {
    amount(maximumAmount);
    if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 255) throw new Error('AssetScale must be an integer from 0 to 255');
    const receipt = await transactions.submit(operationId, {
      TransactionType: 'MPTokenIssuanceCreate', Account: signer.address,
      Flags: CAPABILITIES, MaximumAmount: maximumAmount, AssetScale: assetScale, TransferFee: 0,
      MPTokenMetadata: Buffer.from(JSON.stringify({t:'CMP',n:'Compliance Test Token',d:'Testnet compliance demonstration',ac:'other'})).toString('hex').toUpperCase(),
    }, signer);
    const id = 'mpt_issuance_id' in receipt.meta ? receipt.meta.mpt_issuance_id : undefined;
    if (typeof id !== 'string') throw new Error(`Missing issuance ID in validated metadata: ${receipt.hash}`);
    return MptIssuer.open(transactions, signer, id);
  }
  static async open(transactions: Transactions, signer: Signer, id: string): Promise<MptIssuer> {
    if (!/^[A-Fa-f0-9]{48}$/.test(id)) throw new Error('Invalid MPT issuance id');
    await transactions.checkTestnet();
    const issuer = new MptIssuer(transactions, signer, id.toUpperCase());
    const entry = await issuer.issuance();
    if (entry.Issuer !== signer.address || (entry.Flags & CAPABILITIES) !== CAPABILITIES || entry.DomainID || (entry.Flags & (8 | 16 | 128)) !== 0) throw new Error('Issuance owner or compliance configuration mismatch');
    return issuer;
  }
  async issuance(ledger: number | 'validated' = 'validated'): Promise<MPTokenIssuance> {
    const response = await this.transactions.client.request({ command: 'ledger_entry', mpt_issuance: this.issuanceId, ledger_index: ledger });
    if (!response.result.validated || response.result.node.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Expected validated MPT issuance');
    return response.result.node as MPTokenIssuance;
  }
  async holder(holder: string, ledger: number | 'validated' = 'validated'): Promise<HolderState> {
    holderAddress(holder, this.signer.address);
    try {
      const response = await this.transactions.client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: this.issuanceId, account: holder }, ledger_index: ledger });
      if (!response.result.validated || (response.result.node as {LedgerEntryType: string}).LedgerEntryType !== 'MPToken') throw new Error('Expected validated MPToken');
      const node = response.result.node as unknown as MPToken;
      return { balance: node.MPTAmount ?? '0', authorized: !!(node.Flags & 2), frozen: !!(node.Flags & 1), exists: true };
    } catch (error) {
      if (error instanceof Error && 'data' in error && (error.data as {error?: string}).error === 'entryNotFound') return { balance: '0', authorized: false, frozen: false, exists: false };
      throw error;
    }
  }
  private banKey(holder: string): string { return `ban:${this.issuanceId}:${holder}`; }
  private ensureNotBanned(holder: string): void {
    holderAddress(holder, this.signer.address);
    if (this.transactions.store.get(this.banKey(holder))) throw new Error(`Holder is permanently banned: ${holder}`);
  }
  private send(key: string, tx: SubmittableTransaction): Promise<Receipt> { return this.transactions.submit(`${this.issuanceId}:${key}`, tx, this.signer); }
  approve(holder: string, operationId: string): Promise<Receipt> {
    return this.serial.run(async () => {
      this.ensureNotBanned(holder);
      return this.send(operationId, { TransactionType: 'MPTokenAuthorize', Account: this.signer.address, MPTokenIssuanceID: this.issuanceId, Holder: holder });
    });
  }
  mint(holder: string, value: string, operationId: string): Promise<Receipt> {
    amount(value);
    return this.serial.run(async () => {
      this.ensureNotBanned(holder);
      const tx: SubmittableTransaction = { TransactionType: 'Payment', Account: this.signer.address, Destination: holder, Amount: { mpt_issuance_id: this.issuanceId, value } };
      const completed = this.transactions.completed(`${this.issuanceId}:${operationId}`, tx);
      if (completed) return completed;
      const [state, issuance] = await Promise.all([this.holder(holder), this.issuance()]);
      if (!state.authorized || state.frozen || (issuance.Flags & 1)) throw new Error('Mint blocked: holder unauthorized or holder/issuance frozen');
      return this.send(operationId, tx);
    });
  }
  clawback(holder: string, value: string, operationId: string): Promise<Receipt> {
    holderAddress(holder, this.signer.address); amount(value);
    return this.serial.run(() => this.clawbackInternal(holder, value, operationId));
  }
  private clawbackInternal(holder: string, value: string, key: string): Promise<Receipt> {
    return this.send(key, { TransactionType: 'Clawback', Account: this.signer.address, Holder: holder, Amount: { mpt_issuance_id: this.issuanceId, value } });
  }
  freezeHolder(holder: string, frozen: boolean, operationId: string): Promise<Receipt> {
    if (typeof frozen !== 'boolean') throw new Error('frozen must be a boolean');
    holderAddress(holder, this.signer.address);
    return this.serial.run(async () => {
      if (!frozen) this.ensureNotBanned(holder);
      return this.lock(holder, frozen, operationId);
    });
  }
  freezeAll(frozen: boolean, operationId: string): Promise<Receipt> {
    if (typeof frozen !== 'boolean') throw new Error('frozen must be a boolean');
    return this.serial.run(() => this.lock(undefined, frozen, operationId));
  }
  private lock(holder: string | undefined, frozen: boolean, key: string): Promise<Receipt> {
    return this.send(key, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.address, MPTokenIssuanceID: this.issuanceId, Flags: frozen ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock, ...(holder ? { Holder: holder } : {}) });
  }
  /** Resumable saga, not atomic: persist intent, revoke, lock, drain, verify. */
  ban(holder: string): Promise<HolderState> {
    holderAddress(holder, this.signer.address);
    return this.serial.run(async () => {
      const key = this.banKey(holder);
      this.transactions.store.set(key, { status: 'pending' });
      let state = await this.holder(holder);
      if (state.exists) {
        await this.send(`ban:${holder}:revoke`, { TransactionType: 'MPTokenAuthorize', Account: this.signer.address, MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: Auth.tfMPTUnauthorize });
        await this.lock(holder, true, `ban:${holder}:lock`);
        state = await this.holder(holder);
        if (BigInt(state.balance) > 0n || this.transactions.store.get('unresolved') === `${this.issuanceId}:ban:${holder}:drain`) {
          try { await this.clawbackInternal(holder, MAX_AMOUNT.toString(), `ban:${holder}:drain`); }
          catch (error) {
            // A holder can redeem to zero between the read and clawback, even when locked.
            if (!(error instanceof LedgerFailure && error.receipt.code === 'tecNO_LINE')) throw error;
          }
        }
      }
      state = await this.holder(holder);
      if (state.balance !== '0' || state.authorized) throw new Error('Ban incomplete; reconcile pending transactions and retry');
      this.transactions.store.set(key, { status: 'complete' });
      return state;
    });
  }
}
