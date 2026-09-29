import { AccountSetAsfFlags, LedgerEntry, MPTokenIssuanceCreateFlags as CreateFlags,
  MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags, isValidClassicAddress, decodeAccountID,
  type AccountObject, type Payment } from 'xrpl';
import { Runner, Serial, invariant, type Signer } from './runtime.js';

type MPToken = LedgerEntry.MPToken;
type MPTokenIssuance = LedgerEntry.MPTokenIssuance;
type ObjectEntry = AccountObject | MPToken; // SDK 5.3.0 omits MPToken from AccountObject union.
export const MAX_AMOUNT = (2n ** 63n - 1n).toString();
export const CAPABILITIES = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
  CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export function amount(value: string): string {
  invariant(typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= BigInt(MAX_AMOUNT), 'Amount must be a positive integer string <= 2^63-1');
  return value;
}
export function holderAddress(holder: string, issuer: string): string {
  invariant(isValidClassicAddress(holder) && holder !== issuer, 'Invalid holder classic address');
  return holder;
}
export async function objects(runner: Runner, account: string, ledger: number | 'validated' = 'validated'): Promise<ObjectEntry[]> {
  const pinned = ledger === 'validated' ? await runner.client.getLedgerIndex() : ledger;
  const result: ObjectEntry[] = [];
  let marker: unknown;
  do {
    const page = await runner.client.request({ command: 'account_objects', account, ledger_index: pinned, limit: 400, ...(marker ? { marker } : {}) });
    invariant(page.result.validated, 'Unvalidated account objects');
    result.push(...page.result.account_objects);
    marker = page.result.marker;
  } while (marker);
  return result;
}
/** All mutating calls require stable business-operation IDs. Amounts are atomic units. */
export class MptIssuer {
  private readonly serial = new Serial();
  constructor(readonly runner: Runner, readonly signer: Signer, readonly issuanceId: string) {
    invariant(/^[A-F0-9]{48}$/.test(issuanceId), 'Invalid MPT issuance ID');
    invariant(issuanceId.slice(8) === Buffer.from(decodeAccountID(signer.address)).toString('hex').toUpperCase(), 'Issuance ID belongs to a different issuer');
  }
  static async create(runner: Runner, signer: Signer, key: string): Promise<MptIssuer> {
    // Strict freezes require a dedicated issuer with no deposit-preauthorization bypasses.
    invariant(!(await objects(runner, signer.address)).some(o => o.LedgerEntryType === 'DepositPreauth'), 'Remove issuer deposit preauthorizations before setup');
    await runner.execute(`${key}/deposit-auth`, { TransactionType: 'AccountSet', Account: signer.address, SetFlag: AccountSetAsfFlags.asfDepositAuth }, signer);
    const receipt = await runner.execute(`${key}/create`, { TransactionType: 'MPTokenIssuanceCreate', Account: signer.address,
      Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: MAX_AMOUNT,
      MPTokenMetadata: Buffer.from(JSON.stringify({ t: 'REGTEST', n: 'Regulated Test Token', d: 'Testnet compliance demonstration; no monetary backing', ac: 'other' })).toString('hex').toUpperCase() }, signer);
    const id = (receipt.meta as { mpt_issuance_id?: string }).mpt_issuance_id;
    invariant(id, 'Validated creation metadata omitted issuance ID; reconcile transaction before continuing');
    const issuer = new MptIssuer(runner, signer, id);
    await issuer.assertConfiguration();
    return issuer;
  }
  async issuance(ledger: number | 'validated' = 'validated'): Promise<MPTokenIssuance> {
    const sequence = Number.parseInt(this.issuanceId.slice(0, 8), 16);
    const entry = (await objects(this.runner, this.signer.address, ledger)).find((o): o is MPTokenIssuance => o.LedgerEntryType === 'MPTokenIssuance' && o.Sequence === sequence);
    invariant(entry && entry.Issuer === this.signer.address, 'Issuance not found for issuer');
    return entry;
  }
  async holder(holder: string, ledger: number | 'validated' = 'validated'): Promise<MPToken | undefined> {
    holderAddress(holder, this.signer.address);
    const entry = (await objects(this.runner, holder, ledger)).find((o): o is MPToken => o.LedgerEntryType === 'MPToken' && o.MPTokenIssuanceID === this.issuanceId);
    // rippled omits default-valued fields, including a zero MPTAmount.
    return entry ? { ...entry, MPTAmount: entry.MPTAmount ?? '0' } : undefined;
  }
  async assertConfiguration(): Promise<void> {
    const ledger = await this.runner.client.getLedgerIndex();
    const issuance = await this.issuance(ledger);
    invariant((issuance.Flags & ~1) === CAPABILITIES && !issuance.DomainID && !issuance.TransferFee && !issuance.AssetScale, 'Unsafe or incompatible issuance configuration');
    const account = (await this.runner.client.request({ command: 'account_info', account: this.signer.address, ledger_index: ledger })).result;
    invariant(account.validated && (account.account_data.Flags & LedgerEntry.AccountRootFlags.lsfDepositAuth) !== 0, 'DepositAuth required for strict freezes');
    invariant(!(await objects(this.runner, this.signer.address, ledger)).some(o => o.LedgerEntryType === 'DepositPreauth'), 'Deposit preauthorization bypasses strict freezes');
  }
  private allowed(holder: string): void {
    holderAddress(holder, this.signer.address);
    invariant(!this.runner.journal.banned(this.issuanceId, holder), 'Address is permanently banned by issuer policy');
  }
  approve(holder: string, key: string): Promise<void> {
    return this.serial.run(async () => {
      this.allowed(holder); await this.assertConfiguration();
      invariant(await this.holder(holder), 'Holder must opt in with MPTokenAuthorize first');
      await this.runner.execute(key, { TransactionType: 'MPTokenAuthorize', Account: this.signer.address, MPTokenIssuanceID: this.issuanceId, Holder: holder }, this.signer);
    });
  }
  payment(from: string, to: string, value: string): Payment {
    invariant(isValidClassicAddress(from) && isValidClassicAddress(to), 'Invalid payment address');
    return { TransactionType: 'Payment', Account: from, Destination: to, Amount: { mpt_issuance_id: this.issuanceId, value: amount(value) } };
  }
  issue(holder: string, value: string, key: string): Promise<void> {
    return this.serial.run(async () => {
      this.allowed(holder); await this.assertConfiguration();
      // Issuer payments bypass native MPT locks: enforce the issuer's policy here.
      // A journaled operation must be reconciled, not replaced, even if policy changed.
      if (!this.runner.journal.db.prepare('SELECT id FROM operations WHERE id=?').get(key)) {
        const ledger = await this.runner.client.getLedgerIndex();
        const issuance = await this.issuance(ledger);
        const state = await this.holder(holder, ledger);
        invariant(!(issuance.Flags & 1), 'Issuance is globally frozen');
        invariant(state && (state.Flags & 2), 'Holder is not approved');
        invariant(!(state.Flags & 1), 'Holder is frozen');
      }
      await this.runner.execute(key, this.payment(this.signer.address, holder, value), this.signer);
    });
  }
  freeze(holder: string, frozen: boolean, key: string): Promise<void> {
    return this.serial.run(async () => {
      holderAddress(holder, this.signer.address);
      if (!frozen) this.allowed(holder);
      await this.assertConfiguration(); await this.lock(holder, frozen, key);
    });
  }
  private async lock(holder: string | undefined, frozen: boolean, key: string): Promise<void> {
    await this.runner.execute(key, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.address, MPTokenIssuanceID: this.issuanceId,
      Flags: frozen ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock, ...(holder ? { Holder: holder } : {}) }, this.signer);
  }
  globalFreeze(frozen: boolean, key: string): Promise<void> {
    return this.serial.run(async () => { await this.assertConfiguration(); await this.lock(undefined, frozen, key); });
  }
  clawback(holder: string, value: string, key: string): Promise<void> {
    return this.serial.run(async () => {
      holderAddress(holder, this.signer.address); await this.assertConfiguration();
      await this.reclaim(holder, value, key);
    });
  }
  private async reclaim(holder: string, value: string, key: string): Promise<void> {
    await this.runner.execute(key, { TransactionType: 'Clawback', Account: this.signer.address, Holder: holder,
      Amount: { mpt_issuance_id: this.issuanceId, value: amount(value) } }, this.signer);
  }
  /** Durable, fail-closed saga: persist ban, lock, revoke authorization, drain, verify.
   * Re-run with the same key after interruption. Never unlock a partially banned holder.
   */
  ban(holder: string, reason: string, key: string): Promise<void> {
    return this.serial.run(async () => {
      holderAddress(holder, this.signer.address); invariant(reason.trim(), 'Ban reason required');
      this.runner.journal.ban(this.issuanceId, holder, reason);
      await this.assertConfiguration();
      if (await this.holder(holder)) {
        await this.lock(holder, true, `${key}/lock`);
        await this.runner.execute(`${key}/revoke`, { TransactionType: 'MPTokenAuthorize', Account: this.signer.address,
          MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize }, this.signer);
        if (this.runner.journal.db.prepare('SELECT id FROM operations WHERE id=?').get(`${key}/drain`) || BigInt((await this.holder(holder))?.MPTAmount ?? '0') > 0n) await this.reclaim(holder, MAX_AMOUNT, `${key}/drain`);
      }
      const state = await this.holder(holder);
      invariant(!state || (state.MPTAmount === '0' && !(state.Flags & 2)), 'Ban incomplete: retry same operation');
    });
  }
}
