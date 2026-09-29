import type { MPToken, MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/index.js';
import type { MPTokenIssuanceCreateMetadata } from 'xrpl/dist/npm/models/transactions/MPTokenIssuanceCreate.js';
import { join } from 'node:path';
import {
  AccountSetAsfFlags, MPTokenIssuanceCreateFlags as CreateFlags,
  MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags as AuthFlags,
  isValidClassicAddress,
  type MPTokenAuthorize, type LedgerEntryJsonResponse, type LedgerEntryRequest,
} from 'xrpl';
import { Runtime, readJson, writeJson, rpcError, type Signer } from './runtime.js';
export const CAPABILITIES = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
  CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export const LOCKED = 1;
export const AUTHORIZED = 2;
export const MAX_AMOUNT = (2n ** 63n - 1n).toString();
export function amount(value: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_AMOUNT)) throw new Error('Amount must be a positive integer string <= 2^63-1');
  return value;
}
export function holderAddress(holder: string, issuer: string): string {
  if (!isValidClassicAddress(holder) || holder === issuer) throw new Error('Invalid holder classic address');
  return holder;
}
interface Policy { bans: Record<string, { reason: string; startedAt: string; complete: boolean }> }
/** AssetScale=0: all amount strings are whole token units. KYC decisions belong to the caller. */
export class MptIssuer {
  private constructor(readonly runtime: Runtime, private readonly signer: Signer, readonly issuanceId: string) {
    if (!/^[A-F0-9]{48}$/.test(issuanceId)) throw new Error('Invalid issuance ID');
  }
  static async create(runtime: Runtime, signer: Signer, operationId: string): Promise<MptIssuer> {
    return runtime.run(async () => {
      await runtime.checkNetwork();
      const preauth = await runtime.client.request({ command: 'account_objects', account: signer.classicAddress, type: 'deposit_preauth', ledger_index: 'validated' });
      if (preauth.result.account_objects.length || preauth.result.marker) throw new Error('Issuer must have no deposit preauthorizations');
      await runtime.send(`${operationId}/deposit-auth`, { TransactionType: 'AccountSet', Account: signer.classicAddress, SetFlag: AccountSetAsfFlags.asfDepositAuth }, signer);
      const tx = await runtime.send(`${operationId}/create`, {
        TransactionType: 'MPTokenIssuanceCreate', Account: signer.classicAddress,
        Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: '1000000000', TransferFee: 0,
      }, signer);
      const meta = tx.result.meta as MPTokenIssuanceCreateMetadata;
      if (!meta.mpt_issuance_id) throw new Error('Validated creation missing issuance ID');
      const issuer = new MptIssuer(runtime, signer, meta.mpt_issuance_id);
      await issuer.assertConfiguration(); return issuer;
    });
  }
  static async attach(runtime: Runtime, signer: Signer, id: string): Promise<MptIssuer> {
    const issuer = new MptIssuer(runtime, signer, id); await issuer.assertConfiguration(); return issuer;
  }
  get address(): string { return this.signer.classicAddress; }
  private get policyPath(): string { return join(this.runtime.directory, `policy-${this.issuanceId}.json`); }
  private async policy(): Promise<Policy> { return await readJson<Policy>(this.policyPath) ?? { bans: {} }; }
  async isBanned(holder: string): Promise<boolean> { return Boolean((await this.policy()).bans[holder]); }
  private async allowed(holder: string): Promise<void> {
    holderAddress(holder, this.address);
    if (await this.isBanned(holder)) throw new Error('Address permanently banned by issuer policy');
  }
  async issuance(ledgerHash?: string): Promise<MPTokenIssuance> {
    const r = await this.runtime.client.request({ command: 'ledger_entry', mpt_issuance: this.issuanceId,
      ...(ledgerHash ? { ledger_hash: ledgerHash } : { ledger_index: 'validated' as const }) });
    if (r.result.node.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Wrong ledger entry type');
    return r.result.node;
  }
  async holder(holder: string, ledgerHash?: string): Promise<MPToken | undefined> {
    holderAddress(holder, this.address);
    try {
      const r = await this.runtime.client.request<LedgerEntryRequest, 2, LedgerEntryJsonResponse<MPToken>>({ command: 'ledger_entry', mptoken: { mpt_issuance_id: this.issuanceId, account: holder },
        ...(ledgerHash ? { ledger_hash: ledgerHash } : { ledger_index: 'validated' as const }) });
      if (r.result.node.LedgerEntryType !== 'MPToken') throw new Error('Wrong ledger entry type');
      // rippled omits a zero MPTAmount despite the SDK declaring it required.
      return { ...r.result.node, MPTAmount: r.result.node.MPTAmount ?? '0' };
    } catch (e) { if (rpcError(e, 'entryNotFound')) return undefined; throw e; }
  }
  async assertConfiguration(): Promise<void> {
    const issuance = await this.issuance();
    if (issuance.Issuer !== this.address || (issuance.Flags & ~LOCKED) !== CAPABILITIES ||
        (issuance.AssetScale ?? 0) !== 0 || issuance.DomainID || (issuance.TransferFee ?? 0) !== 0) throw new Error('Issuance outside supported compliance configuration');
    const account = await this.runtime.client.request({ command: 'account_info', account: this.address, ledger_index: 'validated' });
    if (!(account.result.account_data.Flags & 0x01000000)) throw new Error('DepositAuth required to block frozen redemption');
    const preauth = await this.runtime.client.request({ command: 'account_objects', account: this.address, type: 'deposit_preauth', ledger_index: 'validated' });
    if (preauth.result.account_objects.length || preauth.result.marker) throw new Error('Deposit preauthorizations violate strict freeze policy');
  }
  /** Holder signs this independently. This opts in; it does not grant issuer approval. */
  optInTransaction(holder: string): MPTokenAuthorize {
    return { TransactionType: 'MPTokenAuthorize', Account: holderAddress(holder, this.address), MPTokenIssuanceID: this.issuanceId };
  }
  approve(holder: string, id: string): Promise<void> {
    return this.runtime.run(async () => {
      await this.allowed(holder);
      await this.runtime.send(id, { TransactionType: 'MPTokenAuthorize', Account: this.address, MPTokenIssuanceID: this.issuanceId, Holder: holder }, this.signer);
      if (!((await this.holder(holder))!.Flags & AUTHORIZED)) throw new Error('Authorization postcondition failed');
    });
  }
  issue(holder: string, value: string, id: string): Promise<void> {
    amount(value);
    return this.runtime.run(async () => {
      await this.allowed(holder); await this.assertConfiguration();
      const [issuance, holding] = await Promise.all([this.issuance(), this.holder(holder)]);
      if ((issuance.Flags & LOCKED) || (holding && (holding.Flags & LOCKED))) throw new Error('Issuance blocked by freeze policy');
      if (!holding || !(holding.Flags & AUTHORIZED)) throw new Error('Holder is not approved');
      await this.runtime.send(id, { TransactionType: 'Payment', Account: this.address, Destination: holder,
        Amount: { mpt_issuance_id: this.issuanceId, value } }, this.signer);
    });
  }
  clawback(holder: string, value: string, id: string): Promise<void> {
    holderAddress(holder, this.address); amount(value);
    return this.runtime.run(() => this.clawbackInternal(holder, value, id));
  }
  private async clawbackInternal(holder: string, value: string, id: string): Promise<void> {
    await this.runtime.send(id, { TransactionType: 'Clawback', Account: this.address, Holder: holder,
      Amount: { mpt_issuance_id: this.issuanceId, value } }, this.signer);
  }
  private async lockInternal(holder: string | undefined, freeze: boolean, id: string): Promise<void> {
    await this.runtime.send(id, { TransactionType: 'MPTokenIssuanceSet', Account: this.address,
      MPTokenIssuanceID: this.issuanceId, Flags: freeze ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock,
      ...(holder ? { Holder: holder } : {}) }, this.signer);
  }
  setHolderFreeze(holder: string, freeze: boolean, id: string): Promise<void> {
    holderAddress(holder, this.address);
    return this.runtime.run(async () => {
      if (!freeze) await this.allowed(holder);
      await this.assertConfiguration(); await this.lockInternal(holder, freeze, id);
      if (Boolean((await this.holder(holder))!.Flags & LOCKED) !== freeze) throw new Error('Holder freeze postcondition failed');
    });
  }
  setGlobalFreeze(freeze: boolean, id: string): Promise<void> {
    return this.runtime.run(async () => {
      await this.assertConfiguration(); await this.lockInternal(undefined, freeze, id);
      if (Boolean((await this.issuance()).Flags & LOCKED) !== freeze) throw new Error('Global freeze postcondition failed');
    });
  }
  /** Durable deny policy first, then lock, revoke, drain. Retry with the SAME id after interruption. */
  ban(holder: string, reason: string, id: string): Promise<void> {
    holderAddress(holder, this.address);
    if (!reason.trim()) throw new Error('Ban requires an internal compliance reference');
    return this.runtime.run(async () => {
      const policy = await this.policy();
      policy.bans[holder] ??= { reason, startedAt: new Date().toISOString(), complete: false };
      await writeJson(this.policyPath, policy); await this.assertConfiguration();
      let holding = await this.holder(holder);
      if (holding) {
        await this.lockInternal(holder, true, `${id}/lock`);
        await this.runtime.send(`${id}/revoke`, { TransactionType: 'MPTokenAuthorize', Account: this.address,
          MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: AuthFlags.tfMPTUnauthorize }, this.signer);
        holding = await this.holder(holder);
        if (holding && BigInt(holding.MPTAmount) > 0n) await this.clawbackInternal(holder, MAX_AMOUNT, `${id}/drain`);
      }
      holding = await this.holder(holder);
      if (holding && (BigInt(holding.MPTAmount) !== 0n || (holding.Flags & AUTHORIZED))) throw new Error('Ban incomplete: holder must have zero balance and no authorization');
      policy.bans[holder]!.complete = true; await writeJson(this.policyPath, policy);
    });
  }
}
