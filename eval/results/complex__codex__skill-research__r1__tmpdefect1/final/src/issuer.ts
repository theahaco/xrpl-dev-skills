import {
  type Client, type MPTokenAuthorize, type LedgerEntryRequest, type LedgerEntryJsonResponse,
  MPTokenIssuanceCreateFlags as CreateFlags, MPTokenIssuanceSetFlags as SetFlags,
  MPTokenAuthorizeFlags, isValidClassicAddress, convertStringToHex,
} from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { TransactionRunner, TransactionFailure, type Signer, type Receipt, isRpcError } from './transactions.js';

export const CAPABILITIES = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
  CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export const MAX_AMOUNT = (2n ** 63n - 1n).toString();
export function amount(value: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_AMOUNT)) {
    throw new Error('Amount must be a positive canonical integer string at most 2^63-1');
  }
  return value;
}
export function holderAddress(holder: string, issuer: string): void {
  if (!isValidClassicAddress(holder) || holder === issuer) throw new Error('A holder must be a valid classic address other than issuer');
}
export async function preflight(client: Client) {
  const server = (await client.request({ command: 'server_info' })).result.info;
  if (server.network_id !== 1) throw new Error('This module targets testnet only');
  const features = (await client.request({ command: 'feature' })).result.features;
  const amendments = (await client.request({ command: 'ledger_entry', ledger_index: 'validated',
    index: '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4' })).result;
  if (amendments.node.LedgerEntryType !== 'Amendments') throw new Error('Wrong amendments object');
  for (const name of ['MPTokensV1', 'Clawback']) {
    const match = Object.entries(features).find(([, f]) => f.name === name);
    if (!match?.[1].enabled || !amendments.node.Amendments?.includes(match[0])) throw new Error(`Required amendment missing: ${name}`);
  }
  return { server, features, amendments: amendments.node };
}

/** Ledger-native MPT locks permit issuer/holder payments in both directions. NOT an absolute freeze. */
export class MptIssuer {
  constructor(readonly runner: TransactionRunner, readonly signer: Signer, readonly issuanceId: string) {
    if (!/^[A-F0-9]{48}$/.test(issuanceId)) throw new Error('Invalid MPT issuance ID');
  }
  static async create(runner: TransactionRunner, signer: Signer, key: string): Promise<MptIssuer> {
    return runner.exclusive(async () => {
      await preflight(runner.client);
      const receipt = await runner.send(key, {
        TransactionType: 'MPTokenIssuanceCreate', Account: signer.classicAddress,
        Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: '1000000000', TransferFee: 0,
        MPTokenMetadata: convertStringToHex(JSON.stringify({ t: 'KYCDEM', n: 'Compliance test token',
          d: 'Testnet demonstration only; no backing or redemption promise', ac: 'other',
          i: 'example.org/token.png', in: 'Testnet demo issuer' })),
      }, signer);
      const id = 'mpt_issuance_id' in receipt.meta ? receipt.meta.mpt_issuance_id : undefined;
      if (typeof id !== 'string') throw new Error(`Missing issuance ID in ${receipt.hash}`);
      const issuer = new MptIssuer(runner, signer, id);
      await issuer.assertConfiguration(); return issuer;
    });
  }
  async issuance(ledger: number | 'validated' = 'validated'): Promise<MPTokenIssuance> {
    const r = await this.runner.client.request({ command: 'ledger_entry', ledger_index: ledger, mpt_issuance: this.issuanceId });
    if (r.result.node.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Unexpected issuance object');
    return r.result.node;
  }
  async holding(holder: string, ledger: number | 'validated' = 'validated'): Promise<MPToken | undefined> {
    holderAddress(holder, this.signer.classicAddress);
    try {
      const r = await this.runner.client.request<LedgerEntryRequest, 2, LedgerEntryJsonResponse<MPToken>>({ command: 'ledger_entry', ledger_index: ledger,
        mptoken: { mpt_issuance_id: this.issuanceId, account: holder } });
      if (r.result.node.LedgerEntryType !== 'MPToken') throw new Error('Unexpected holding object');
      // rippled omits the default zero field despite the SDK marking it required.
      return { ...r.result.node, MPTAmount: r.result.node.MPTAmount ?? '0' };
    } catch (error) { if (isRpcError(error, 'entryNotFound')) return undefined; throw error; }
  }
  async assertConfiguration(): Promise<void> {
    const issuance = await this.issuance();
    if (issuance.Issuer !== this.signer.classicAddress || (issuance.Flags & ~1) !== CAPABILITIES ||
      (issuance.AssetScale ?? 0) !== 0 || (issuance.TransferFee ?? 0) !== 0 || issuance.DomainID) {
      throw new Error('Issuance must have exact compliance capabilities, scale 0, no fees or domain authorization');
    }
  }
  private allowed(holder: string): void {
    holderAddress(holder, this.signer.classicAddress);
    if (this.runner.isBanned(this.issuanceId, holder)) throw new Error('Address is permanently banned by issuer policy');
  }
  private authorization(holder: string, revoke = false): MPTokenAuthorize {
    return { TransactionType: 'MPTokenAuthorize', Account: this.signer.classicAddress,
      MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: revoke ? MPTokenAuthorizeFlags.tfMPTUnauthorize : 0 };
  }
  /** Only call after your backend's KYC decision. No PII goes onto the ledger. */
  approve(holder: string, key: string): Promise<Receipt> {
    return this.runner.exclusive(async () => {
      this.allowed(holder); await this.assertConfiguration();
      return this.runner.send(key, this.authorization(holder), this.signer);
    });
  }
  issue(holder: string, value: string, key: string): Promise<Receipt> {
    amount(value);
    return this.runner.exclusive(async () => {
      this.allowed(holder); await this.assertConfiguration();
      const issuance = await this.issuance(); const holding = await this.holding(holder);
      if ((issuance.Flags & 1) || !holding || (holding.Flags & 1) || !(holding.Flags & 2)) throw new Error('Recipient unapproved or frozen');
      return this.runner.send(key, { TransactionType: 'Payment', Account: this.signer.classicAddress,
        Destination: holder, Amount: { mpt_issuance_id: this.issuanceId, value } }, this.signer);
    });
  }
  clawback(holder: string, value: string, key: string): Promise<Receipt> {
    holderAddress(holder, this.signer.classicAddress); amount(value);
    return this.runner.exclusive(async () => { await this.assertConfiguration(); return this.clawbackInternal(holder, value, key); });
  }
  private clawbackInternal(holder: string, value: string, key: string): Promise<Receipt> {
    return this.runner.send(key, { TransactionType: 'Clawback', Account: this.signer.classicAddress,
      Holder: holder, Amount: { mpt_issuance_id: this.issuanceId, value } }, this.signer);
  }
  private lockInternal(locked: boolean, key: string, holder?: string): Promise<Receipt> {
    return this.runner.send(key, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.classicAddress,
      MPTokenIssuanceID: this.issuanceId, Flags: locked ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock,
      ...(holder ? { Holder: holder } : {}) }, this.signer);
  }
  freezeHolder(holder: string, locked: boolean, key: string): Promise<Receipt> {
    holderAddress(holder, this.signer.classicAddress);
    return this.runner.exclusive(async () => {
      if (!locked) this.allowed(holder);
      await this.assertConfiguration(); return this.lockInternal(locked, key, holder);
    });
  }
  freezeGlobal(locked: boolean, key: string): Promise<Receipt> {
    return this.runner.exclusive(async () => { await this.assertConfiguration(); return this.lockInternal(locked, key); });
  }
  /** Resumable saga: durable deny -> revoke authorization -> claw back -> verify.
   * Revocation prevents incoming transfers even if the holder deletes/recreates its object.
   * Redemption remains possible during the saga.
   */
  ban(holder: string, reason: string, key: string): Promise<void> {
    holderAddress(holder, this.signer.classicAddress);
    return this.runner.exclusive(async () => {
      await this.assertConfiguration(); this.runner.markBanned(this.issuanceId, holder, reason);
      const holding = await this.holding(holder);
      if (holding || this.runner.hasOperation(`${key}:revoke`)) {
        try { await this.runner.send(`${key}:revoke`, this.authorization(holder, true), this.signer); }
        catch (error) {
          // An empty holding can be deleted between the read and revocation.
          if (!(error instanceof TransactionFailure) || error.receipt.code !== 'tecOBJECT_NOT_FOUND') throw error;
        }
        const current = await this.holding(holder);
        if ((current && BigInt(current.MPTAmount) > 0n) || this.runner.hasOperation(`${key}:drain`)) {
          try { await this.clawbackInternal(holder, MAX_AMOUNT, `${key}:drain`); }
          catch (error) {
            // A redemption racing the clawback may already have drained the holder.
            // Only accept these validated failures if the final state below proves the ban.
            if (!(error instanceof TransactionFailure) || !['tecNO_LINE', 'tecOBJECT_NOT_FOUND'].includes(error.receipt.code)) throw error;
          }
        }
      }
      const end = await this.holding(holder);
      if (end && (end.MPTAmount !== '0' || (end.Flags & 2))) throw new Error('Ban incomplete; resume the same operation');
    });
  }
}
