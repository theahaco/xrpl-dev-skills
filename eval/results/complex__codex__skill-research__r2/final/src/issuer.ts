import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import {
  isValidClassicAddress, MPTokenIssuanceCreateFlags as CreateFlags,
  MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags as AuthFlags,
  type SubmittableTransaction as Transaction,
} from 'xrpl';
import { Ledger, type Signer } from './ledger.js';

export const MAX_AMOUNT = '9223372036854775807';
export const CAPABILITIES = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth | CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export function amount(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 19 || BigInt(value) > BigInt(MAX_AMOUNT)) throw new Error('Amount must be a positive canonical integer string, at most 2^63-1');
  return value;
}
export function holder(address: string, issuer: string): string {
  if (!isValidClassicAddress(address) || address === issuer) throw new Error('Expected a non-issuer classic address');
  return address;
}
export function optIn(account: string, issuanceId: string): Transaction {
  if (!isValidClassicAddress(account) || !/^[A-F0-9]{48}$/.test(issuanceId)) throw new Error('Invalid account or issuance ID');
  return { TransactionType: 'MPTokenAuthorize', Account: account, MPTokenIssuanceID: issuanceId };
}

/** Native MPT locks exempt direct issuer payments (issuance and redemption). This API does not promise absolute immobilization. */
export class Issuer {
  constructor(readonly ledger: Ledger, readonly signer: Signer, readonly issuanceId: string) {
    if (!/^[A-F0-9]{48}$/.test(issuanceId)) throw new Error('Invalid MPT issuance ID');
  }
  static async create(ledger: Ledger, signer: Signer, operationId: string): Promise<Issuer> {
    return ledger.exclusive(async () => {
      const receipt = await ledger.send(operationId, {
        TransactionType: 'MPTokenIssuanceCreate', Account: signer.classicAddress,
        Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: MAX_AMOUNT,
      }, signer);
      const metadata = receipt.meta as typeof receipt.meta & { mpt_issuance_id?: string };
      if (!metadata.mpt_issuance_id) throw new Error('Validated issuance metadata lacks issuance ID');
      const issuer = new Issuer(ledger, signer, metadata.mpt_issuance_id);
      await issuer.check();
      return issuer;
    });
  }
  async issuance(ledgerIndex: number | 'validated' = 'validated'): Promise<MPTokenIssuance> {
    const r = (await this.ledger.client.request({ command: 'ledger_entry', mpt_issuance: this.issuanceId, ledger_index: ledgerIndex })).result;
    if (!r.validated || r.node.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Invalid issuance response');
    return r.node;
  }
  async holding(address: string, ledgerIndex: number | 'validated' = 'validated'): Promise<MPToken | undefined> {
    holder(address, this.signer.classicAddress);
    try {
      const r = (await this.ledger.client.request({ command: 'ledger_entry', mptoken: { account: address, mpt_issuance_id: this.issuanceId }, ledger_index: ledgerIndex })).result;
      const node = r.node as unknown as MPToken;
      if (!r.validated || node.LedgerEntryType !== 'MPToken') throw new Error('Invalid holder response');
      // rippled omits zero-valued fields even though SDK 5.3 declares MPTAmount required.
      const balance = node.MPTAmount ?? '0';
      if (!/^(0|[1-9][0-9]*)$/.test(balance) || BigInt(balance) > BigInt(MAX_AMOUNT)) throw new Error('Invalid ledger MPT balance');
      return { ...node, MPTAmount: balance };
    } catch (error) {
      if (error && typeof error === 'object' && 'data' in error && (error.data as { error?: string })?.error === 'entryNotFound') return undefined;
      throw error;
    }
  }
  private async check(): Promise<void> {
    const entry = await this.issuance();
    if (entry.Issuer !== this.signer.classicAddress || (entry.Flags & ~1) !== CAPABILITIES || (entry.AssetScale ?? 0) !== 0 || entry.DomainID || entry.TransferFee)
      throw new Error('Issuance does not match the supported compliance profile');
  }
  private banKey(address: string): string { return `ban:${this.issuanceId}:${address}`; }
  isBanned(address: string): boolean { return this.ledger.store.get<boolean>(this.banKey(address)) === true; }
  private permitted(address: string): void {
    holder(address, this.signer.classicAddress);
    if (this.isBanned(address)) throw new Error('Address is permanently banned by issuer policy');
  }
  private send(id: string, tx: Transaction) { return this.ledger.send(`${this.issuanceId}:${id}`, tx, this.signer); }
  approve(address: string, operationId: string) {
    return this.ledger.exclusive(async () => {
      this.permitted(address); await this.check();
      return this.send(operationId, { TransactionType: 'MPTokenAuthorize', Account: this.signer.classicAddress, Holder: address, MPTokenIssuanceID: this.issuanceId });
    });
  }
  issue(address: string, value: string, operationId: string) {
    return this.ledger.exclusive(async () => {
      this.permitted(address); amount(value); await this.check();
      const ledgerIndex = await this.ledger.client.getLedgerIndex();
      const issuance = await this.issuance(ledgerIndex), holding = await this.holding(address, ledgerIndex);
      if (!holding || (holding.Flags & 2) === 0) throw new Error('Holder is not approved');
      if ((issuance.Flags & 1) !== 0 || (holding.Flags & 1) !== 0) throw new Error('Issuance or holder is locked');
      return this.send(operationId, { TransactionType: 'Payment', Account: this.signer.classicAddress, Destination: address, Amount: { mpt_issuance_id: this.issuanceId, value } });
    });
  }
  clawback(address: string, value: string, operationId: string) {
    return this.ledger.exclusive(async () => {
      holder(address, this.signer.classicAddress); amount(value); await this.check();
      return this.send(operationId, { TransactionType: 'Clawback', Account: this.signer.classicAddress, Holder: address, Amount: { mpt_issuance_id: this.issuanceId, value } });
    });
  }
  freeze(address: string, operationId: string) { return this.lock(true, operationId, address); }
  unfreeze(address: string, operationId: string) { return this.lock(false, operationId, address); }
  freezeGlobal(operationId: string) { return this.lock(true, operationId); }
  unfreezeGlobal(operationId: string) { return this.lock(false, operationId); }
  private lock(locked: boolean, operationId: string, address?: string) {
    return this.ledger.exclusive(async () => {
      if (address) { holder(address, this.signer.classicAddress); if (!locked) this.permitted(address); }
      await this.check();
      return this.send(operationId, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.classicAddress, MPTokenIssuanceID: this.issuanceId, Flags: locked ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock, ...(address ? { Holder: address } : {}) });
    });
  }
  /** Resumable fail-closed workflow. Completion means validated zero balance and revoked authorization. */
  ban(address: string, operationId: string): Promise<void> {
    return this.ledger.exclusive(async () => {
      holder(address, this.signer.classicAddress); await this.check();
      const workflow = `ban-workflow:${this.issuanceId}:${operationId}`;
      const prior = this.ledger.store.get<string>(workflow);
      if (prior && prior !== address) throw new Error('Ban operation ID reused for another address');
      this.ledger.store.put(workflow, address);
      this.ledger.store.put(this.banKey(address), true);
      // Revoke first: no inbound payments can race with draining; deletion/recreation does not restore approval.
      if (this.ledger.store.get(`tx:${this.issuanceId}:${operationId}:revoke`) || await this.holding(address)) {
        await this.send(`${operationId}:revoke`, { TransactionType: 'MPTokenAuthorize', Account: this.signer.classicAddress, Holder: address, MPTokenIssuanceID: this.issuanceId, Flags: AuthFlags.tfMPTUnauthorize });
        if (this.ledger.store.get(`tx:${this.issuanceId}:${operationId}:drain`) || BigInt((await this.holding(address))?.MPTAmount ?? '0') > 0n)
          await this.send(`${operationId}:drain`, { TransactionType: 'Clawback', Account: this.signer.classicAddress, Holder: address, Amount: { mpt_issuance_id: this.issuanceId, value: MAX_AMOUNT } });
      }
      const final = await this.holding(address);
      if (final && (BigInt(final.MPTAmount) !== 0n || (final.Flags & 2) !== 0)) throw new Error('Ban incomplete; retry the same operation ID');
    });
  }
}
