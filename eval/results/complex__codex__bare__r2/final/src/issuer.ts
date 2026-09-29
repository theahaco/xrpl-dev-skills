import { Client, Wallet, isValidClassicAddress, MPTokenIssuanceCreateFlags as F,
  type SubmittableTransaction as Transaction, type TransactionMetadata } from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';

export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export const MAX_AMOUNT = 9223372036854775807n;
export const CAPABILITIES = F.tfMPTCanLock | F.tfMPTRequireAuth | F.tfMPTCanTransfer | F.tfMPTCanClawback;
export function amount(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > MAX_AMOUNT) throw new Error('Amount must be a positive integer string <= 2^63-1');
  return value;
}
export function holderAddress(value: string, issuer: string): string {
  if (!isValidClassicAddress(value) || value === issuer) throw new Error('Expected a non-issuer classic address');
  return value;
}
export interface Receipt { hash: string; ledgerIndex: number; code: string; meta: TransactionMetadata }
export interface Prepared { hash: string; blob: string; lastLedgerSequence: number; transaction: Transaction }
/** Persist before submission. A pending transaction MUST be reconciled by hash before a new attempt. */
export interface Journal {
  prepared(record: Prepared): Promise<void>;
  validated(receipt: Receipt): Promise<void>;
}
/** Must be durable, shared across all issuer workers, and fail closed on storage errors. */
export interface BanStore {
  has(issuanceId: string, holder: string): Promise<boolean>;
  add(issuanceId: string, holder: string): Promise<void>;
}
export class LedgerFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`${receipt.code}: ${receipt.hash}`); }
}
export class SubmissionUnknown extends Error {
  constructor(readonly hash: string, options: ErrorOptions) { super(`Reconcile transaction ${hash} before sending another transaction`, options); }
}

/** One instance per signing account; use an external account lock across processes. */
export class TransactionRunner {
  private tail: Promise<unknown> = Promise.resolve();
  private uncertain = false;
  constructor(readonly client: Client, private readonly journal: Journal) {}
  async assertTestnet(): Promise<void> {
    const info = (await this.client.request({ command: 'server_info' })).result.info;
    if (info.network_id !== 1) throw new Error('Refusing to transact outside XRPL testnet (network ID 1)');
  }
  submit(wallet: Wallet, transaction: Transaction): Promise<Receipt> {
    const work = this.tail.then(async () => {
      if (this.uncertain) throw new Error('Runner halted: reconcile the pending transaction and restart');
      if (transaction.Account !== wallet.classicAddress) throw new Error('Signer/account mismatch');
      await this.assertTestnet();
      const prepared = await this.client.autofill(transaction);
      if (!prepared.LastLedgerSequence || BigInt(prepared.Fee ?? '0') > 1000n) throw new Error('Unsafe expiry or fee (maximum 1000 drops)');
      const signed = wallet.sign(prepared);
      let receipt: Receipt;
      try {
        await this.journal.prepared({ hash: signed.hash, blob: signed.tx_blob, lastLedgerSequence: prepared.LastLedgerSequence, transaction: prepared });
        const response = await this.client.submitAndWait(signed.tx_blob);
        const r = response.result;
        if (!r.validated || !r.ledger_index || !r.meta || typeof r.meta === 'string') throw new Error('Missing validated metadata');
        receipt = { hash: signed.hash, ledgerIndex: r.ledger_index, code: r.meta.TransactionResult, meta: r.meta };
        await this.journal.validated(receipt);
      } catch (cause) {
        this.uncertain = true;
        throw new SubmissionUnknown(signed.hash, { cause });
      }
      if (receipt.code !== 'tesSUCCESS') throw new LedgerFailure(receipt);
      return receipt;
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
}

export class MptIssuer {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly runner: TransactionRunner, private readonly wallet: Wallet,
    readonly issuanceId: string, private readonly bans: BanStore) {
    if (!/^[A-Fa-f0-9]{48}$/.test(issuanceId)) throw new Error('Invalid MPT issuance ID');
  }
  static async create(runner: TransactionRunner, wallet: Wallet, bans: BanStore): Promise<MptIssuer> {
    const receipt = await runner.submit(wallet, { TransactionType: 'MPTokenIssuanceCreate', Account: wallet.classicAddress,
      Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: '1000000000',
      MPTokenMetadata: Buffer.from(JSON.stringify({ t: 'REGTEST', n: 'Compliance test token', d: 'Testnet only; no monetary value', ac: 'other' })).toString('hex').toUpperCase() });
    const meta = receipt.meta as TransactionMetadata & { mpt_issuance_id?: string };
    if (!meta.mpt_issuance_id) throw new Error(`Issuance created, recover ID from ${receipt.hash}; do not create again`);
    const issuer = new MptIssuer(runner, wallet, meta.mpt_issuance_id, bans);
    await issuer.assertCapabilities();
    return issuer;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.tail.then(fn); this.tail = work.catch(() => undefined); return work;
  }
  private holder(address: string): string { return holderAddress(address, this.wallet.classicAddress); }
  async issuance(ledger: number | 'validated' = 'validated'): Promise<MPTokenIssuance> {
    const node = (await this.runner.client.request({ command: 'ledger_entry', mpt_issuance: this.issuanceId, ledger_index: ledger })).result.node;
    if (node.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Unexpected ledger entry');
    return node;
  }
  async holding(address: string, ledger: number | 'validated' = 'validated'): Promise<MPToken | undefined> {
    this.holder(address);
    try {
      const node = (await this.runner.client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: this.issuanceId, account: address }, ledger_index: ledger })).result.node as unknown as MPToken;
      if (!node || node.LedgerEntryType !== 'MPToken' || !Number.isInteger(node.Flags) ||
        (node.MPTAmount !== undefined && !/^[0-9]+$/.test(node.MPTAmount))) throw new Error('Unexpected ledger entry');
      return node;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'data' in error &&
        (error.data as { error?: string } | undefined)?.error === 'entryNotFound') return undefined;
      throw error;
    }
  }
  async assertCapabilities(): Promise<void> {
    const entry = await this.issuance();
    if (entry.Issuer !== this.wallet.classicAddress || (entry.Flags & CAPABILITIES) !== CAPABILITIES ||
      (entry.Flags & (8 | 16 | 128)) !== 0 || entry.DomainID) throw new Error('Unsupported issuer, capabilities, or permissioned domain');
  }
  private async allowed(address: string): Promise<void> {
    this.holder(address);
    if (await this.bans.has(this.issuanceId, address)) throw new Error('Address is permanently banned by issuer policy');
  }
  private send(tx: Transaction): Promise<Receipt> { return this.runner.submit(this.wallet, tx); }
  approve(address: string): Promise<void> { return this.serial(async () => {
    await this.assertCapabilities(); await this.allowed(address);
    await this.send({ TransactionType: 'MPTokenAuthorize', Account: this.wallet.classicAddress, MPTokenIssuanceID: this.issuanceId, Holder: address });
  }); }
  mint(address: string, value: string): Promise<void> { return this.serial(async () => {
    amount(value); await this.assertCapabilities(); await this.allowed(address);
    const [issuance, holding] = await Promise.all([this.issuance(), this.holding(address)]);
    if ((issuance.Flags & 1) || !holding || (holding.Flags & 3) !== 2) throw new Error('Mint requires an approved, unlocked holder and unlocked issuance');
    await this.send({ TransactionType: 'Payment', Account: this.wallet.classicAddress, Destination: address, Amount: { mpt_issuance_id: this.issuanceId, value } });
  }); }
  private async lock(locked: boolean, address?: string): Promise<void> {
    await this.assertCapabilities();
    if (address !== undefined) { this.holder(address); if (!locked) await this.allowed(address); }
    await this.send({ TransactionType: 'MPTokenIssuanceSet', Account: this.wallet.classicAddress, MPTokenIssuanceID: this.issuanceId,
      Flags: locked ? 1 : 2, ...(address === undefined ? {} : { Holder: address }) });
  }
  freeze(address: string): Promise<void> { return this.serial(() => this.lock(true, address)); }
  unfreeze(address: string): Promise<void> { return this.serial(() => this.lock(false, address)); }
  freezeAll(): Promise<void> { return this.serial(() => this.lock(true)); }
  unfreezeAll(): Promise<void> { return this.serial(() => this.lock(false)); }
  private async claw(address: string, value: string): Promise<void> {
    this.holder(address); amount(value); await this.assertCapabilities();
    await this.send({ TransactionType: 'Clawback', Account: this.wallet.classicAddress, Holder: address, Amount: { mpt_issuance_id: this.issuanceId, value } });
  }
  /** Ledger claws back min(requested, current balance); a zero balance fails. */
  clawback(address: string, value: string): Promise<void> { return this.serial(() => this.claw(address, value)); }
  /** Durable intent -> revoke -> lock -> claw back -> verify. Safe to resume after partial completion. */
  ban(address: string): Promise<void> { return this.serial(async () => {
    this.holder(address); await this.assertCapabilities();
    await this.bans.add(this.issuanceId, address);
    let holding = await this.holding(address);
    if (holding && (holding.Flags & 2)) await this.send({ TransactionType: 'MPTokenAuthorize', Account: this.wallet.classicAddress,
      MPTokenIssuanceID: this.issuanceId, Holder: address, Flags: 1 });
    holding = await this.holding(address);
    if (holding) {
      if (!(holding.Flags & 1)) await this.lock(true, address);
      if (BigInt(holding.MPTAmount ?? '0') > 0n) await this.claw(address, MAX_AMOUNT.toString());
    }
    const final = await this.holding(address);
    if (final && (BigInt(final.MPTAmount ?? '0') !== 0n || (final.Flags & 2))) throw new Error('Ban incomplete; resume ban before reporting success');
  }); }
}
