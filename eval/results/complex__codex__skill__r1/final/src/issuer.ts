import { isValidClassicAddress, MPTokenIssuanceCreateFlags as Create, type SubmittableTransaction } from 'xrpl';
import type { Store } from './store.js';
import { Transactions, type Signer } from './transactions.js';
export interface MPToken { LedgerEntryType: 'MPToken'; MPTAmount: string; Flags: number }
export interface MPTokenIssuance { LedgerEntryType: 'MPTokenIssuance'; Issuer: string; Flags: number; OutstandingAmount: string; DomainID?: string; TransferFee?: number }
function parseEntry<T>(value: unknown, type: string): T {
  if (!value || typeof value !== 'object' || !('LedgerEntryType' in value) || value.LedgerEntryType !== type || !('Flags' in value) || typeof value.Flags !== 'number') throw new Error('Unexpected ledger entry');
  const entry = value as Record<string, unknown>;
  const amountField = type === 'MPToken' ? 'MPTAmount' : 'OutstandingAmount';
  const balance = entry[amountField] ?? '0';
  if (typeof balance !== 'string' || !/^(0|[1-9][0-9]*)$/.test(balance) || BigInt(balance) > MAX_AMOUNT) throw new Error('Invalid ledger balance');
  if (type === 'MPTokenIssuance' && (typeof entry.Issuer !== 'string' || !isValidClassicAddress(entry.Issuer))) throw new Error('Invalid ledger issuer');
  return { ...entry, [amountField]: balance } as T;
}
export const CAPABILITIES = Create.tfMPTCanLock | Create.tfMPTRequireAuth | Create.tfMPTCanClawback | Create.tfMPTCanTransfer;
export const MAX_AMOUNT = 9223372036854775807n;
export function amount(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > MAX_AMOUNT) throw new Error('Amount must be a positive integer string <= 2^63-1 (base units)');
  return value;
}
export function holderAddress(address: string, issuer: string): string {
  if (!isValidClassicAddress(address) || address === issuer) throw new Error('Expected a classic holder address distinct from issuer');
  return address;
}
export class MptIssuer {
  private tail: Promise<unknown> = Promise.resolve();
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  constructor(readonly transactions: Transactions, private readonly signer: Signer, readonly issuanceId: string, private readonly store: Store) {
    if (!/^[A-Fa-f0-9]{48}$/.test(issuanceId)) throw new Error('Invalid MPT issuance ID');
  }
  static async create(transactions: Transactions, signer: Signer, store: Store, operationId: string): Promise<MptIssuer> {
    const receipt = await transactions.submit(operationId, {
      TransactionType: 'MPTokenIssuanceCreate', Account: signer.classicAddress,
      Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: '1000000000',
      MPTokenMetadata: Buffer.from(JSON.stringify({ name: 'Compliance Test Token', symbol: 'CTT', purpose: 'Testnet demonstration only' })).toString('hex').toUpperCase(),
    }, signer);
    const meta = receipt.meta as typeof receipt.meta & { mpt_issuance_id?: string };
    if (!meta.mpt_issuance_id) throw new Error(`Missing issuance ID in validated metadata: ${receipt.hash}`);
    return new MptIssuer(transactions, signer, meta.mpt_issuance_id, store);
  }
  private holder(address: string): string { return holderAddress(address, this.signer.classicAddress); }
  private banKey(holder: string): string { return `ban-${this.issuanceId}-${holder}`; }
  private async notBanned(holder: string): Promise<void> {
    if (await this.store.get(this.banKey(holder))) throw new Error('Holder is permanently banned by issuer policy');
  }
  private async send(id: string, tx: SubmittableTransaction) {
    await this.assertCapabilities();
    return this.transactions.submit(id, tx, this.signer);
  }
  async issuance(ledgerHash?: string): Promise<MPTokenIssuance> {
    const response = await this.transactions.client.request({ command: 'ledger_entry', mpt_issuance: this.issuanceId, ...(ledgerHash ? { ledger_hash: ledgerHash } : { ledger_index: 'validated' as const }) });
    return parseEntry<MPTokenIssuance>(response.result.node, 'MPTokenIssuance');
  }
  async holding(holder: string, ledgerHash?: string): Promise<MPToken | undefined> {
    this.holder(holder);
    try {
      const response = await this.transactions.client.request({ command: 'ledger_entry', mptoken: { account: holder, mpt_issuance_id: this.issuanceId }, ...(ledgerHash ? { ledger_hash: ledgerHash } : { ledger_index: 'validated' as const }) });
      return parseEntry<MPToken>(response.result.node, 'MPToken');
    } catch (error) {
      if ((error as { data?: { error?: string } }).data?.error === 'entryNotFound') return undefined;
      throw error;
    }
  }
  async assertCapabilities(): Promise<void> {
    const entry = await this.issuance();
    if (entry.Issuer !== this.signer.classicAddress || (entry.Flags & CAPABILITIES) !== CAPABILITIES || (entry.Flags & (8 | 16 | 128)) || entry.DomainID || entry.TransferFee) throw new Error('Issuance does not match compliance policy');
  }
  approve(id: string, holder: string) { return this.serial(() => this.authorize(id, holder, true)); }
  revoke(id: string, holder: string) { return this.serial(() => this.authorize(id, holder, false)); }
  private async authorize(id: string, holder: string, approve: boolean) {
    this.holder(holder);
    if (approve) await this.notBanned(holder);
    return this.send(id, { TransactionType: 'MPTokenAuthorize', Account: this.signer.classicAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: approve ? 0 : 1 });
  }
  mint(id: string, holder: string, value: string) { return this.serial(() => this.mintInternal(id, holder, value)); }
  clawback(id: string, holder: string, value: string) { return this.serial(() => this.clawbackInternal(id, holder, value)); }
  freeze(id: string, holder: string, frozen: boolean) { return this.serial(() => this.freezeInternal(id, holder, frozen)); }
  globalFreeze(id: string, frozen: boolean) { return this.serial(() => this.globalFreezeInternal(id, frozen)); }
  ban(id: string, holder: string) { return this.serial(() => this.banInternal(id, holder)); }
  private async mintInternal(id: string, holder: string, value: string) {
    this.holder(holder); await this.notBanned(holder);
    return this.send(id, { TransactionType: 'Payment', Account: this.signer.classicAddress, Destination: holder, Amount: { mpt_issuance_id: this.issuanceId, value: amount(value) } });
  }
  private async clawbackInternal(id: string, holder: string, value: string) {
    this.holder(holder);
    return this.send(id, { TransactionType: 'Clawback', Account: this.signer.classicAddress, Holder: holder, Amount: { mpt_issuance_id: this.issuanceId, value: amount(value) } });
  }
  private async freezeInternal(id: string, holder: string, frozen: boolean) {
    this.holder(holder); if (!frozen) await this.notBanned(holder);
    return this.send(id, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.classicAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: frozen ? 1 : 2 });
  }
  private globalFreezeInternal(id: string, frozen: boolean) {
    return this.send(id, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.classicAddress, MPTokenIssuanceID: this.issuanceId, Flags: frozen ? 1 : 2 });
  }
  /** Resumable, fail-closed workflow. Not an atomic ledger operation. Call with the same ID on retry. */
  private async banInternal(id: string, holder: string): Promise<void> {
    this.holder(holder);
    await this.store.put(this.banKey(holder), { banned: true });
    // Revoke FIRST: eliminates incoming funds even if the holder deletes/recreates its object.
    if (await this.holding(holder)) {
      await this.authorize(`${id}-revoke`, holder, false);
      const balance = await this.holding(holder);
      if (balance && BigInt(balance.MPTAmount) > 0n) await this.clawbackInternal(`${id}-clawback`, holder, MAX_AMOUNT.toString());
    }
    const final = await this.holding(holder);
    if (final && (BigInt(final.MPTAmount) !== 0n || (final.Flags & 2) !== 0)) throw new Error('Ban incomplete; retry same operation ID');
  }
}
