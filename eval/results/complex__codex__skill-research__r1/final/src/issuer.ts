import type { MPToken, MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/index.js';
import { MPTokenIssuanceCreateFlags as Create, MPTokenIssuanceSetFlags as Lock,
  MPTokenAuthorizeFlags as Auth, convertStringToHex, type LedgerEntryRequest, type LedgerEntryResponse, type MPTokenAuthorize } from 'xrpl';
import { address, rpcError, Submitter, LedgerFailure, type Signer } from './ledger.js';
import { Serial } from './store.js';

export const MAX_AMOUNT = 9223372036854775807n;
export const CAPABILITIES = Create.tfMPTCanLock | Create.tfMPTRequireAuth | Create.tfMPTCanTransfer | Create.tfMPTCanClawback;
export function amount(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 19 || BigInt(value) > MAX_AMOUNT) throw new Error('Amount must be a positive integer string <= 2^63-1');
  return value;
}
export function issuanceId(value: string): string {
  if (!/^[A-Fa-f0-9]{48}$/.test(value)) throw new Error('Invalid MPT issuance ID');
  return value.toUpperCase();
}
export function holderOptIn(account: string, id: string): MPTokenAuthorize {
  return { TransactionType: 'MPTokenAuthorize', Account: address(account), MPTokenIssuanceID: issuanceId(id) };
}
/** Amounts are integer base units. AssetScale is deliberately zero for this issuance. */
export class MptIssuer {
  private readonly serial: Serial;
  readonly id: string;
  constructor(readonly submitter: Submitter, private readonly signer: Signer, id: string) {
    this.id = issuanceId(id); address(signer.classicAddress);
    this.serial = submitter.operations;
  }
  static async create(submitter: Submitter, signer: Signer, operationId: string): Promise<MptIssuer> {
    const receipt = await submitter.submit(operationId, {
      TransactionType: 'MPTokenIssuanceCreate', Account: signer.classicAddress,
      Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: MAX_AMOUNT.toString(), TransferFee: 0,
      MPTokenMetadata: convertStringToHex(JSON.stringify({ t: 'RCUSD', n: 'Regulated Compliance Demo',
        d: 'Testnet compliance demonstration; no monetary value or redemption promise.', ac: 'other' })),
    }, signer);
    if (!receipt.issuanceId) throw new Error('Validated create metadata has no issuance ID');
    const issuer = new MptIssuer(submitter, signer, receipt.issuanceId);
    await issuer.assertConfiguration();
    return issuer;
  }
  async issuance(ledger: number | 'validated' = 'validated'): Promise<MPTokenIssuance> {
    const { result } = await this.submitter.client.request({ command: 'ledger_entry', mpt_issuance: this.id, ledger_index: ledger });
    if (!result.validated || result.node.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Invalid issuance response');
    return result.node;
  }
  async holder(holder: string, ledger: number | 'validated' = 'validated'): Promise<MPToken | undefined> {
    try {
      const { result } = await this.submitter.client.request<LedgerEntryRequest, 2, LedgerEntryResponse<MPToken>>({ command: 'ledger_entry',
        mptoken: { mpt_issuance_id: this.id, account: address(holder) }, ledger_index: ledger });
      if (!result.validated || result.node?.LedgerEntryType !== 'MPToken') throw new Error('Invalid holder response');
      // rippled omits a default zero MPTAmount despite the SDK declaring it required.
      const balance = result.node.MPTAmount ?? '0';
      if (!/^(0|[1-9][0-9]*)$/.test(balance) || BigInt(balance) > MAX_AMOUNT) throw new Error('Invalid holder balance');
      return { ...result.node, MPTAmount: balance };
    } catch (error) { if (rpcError(error) === 'entryNotFound') return undefined; throw error; }
  }
  async assertConfiguration(): Promise<void> {
    const state = await this.issuance();
    if (state.Issuer !== this.signer.classicAddress || (state.Flags & ~1) !== CAPABILITIES ||
        (state.AssetScale ?? 0) !== 0 || state.DomainID || (state.TransferFee ?? 0) !== 0) throw new Error('Issuance does not match compliance policy');
  }
  private banKey(holder: string): string { return `ban:${this.id}:${address(holder)}`; }
  isBanned(holder: string): boolean { return this.submitter.store.get(this.banKey(holder)) !== undefined; }
  private allowed(holder: string): void {
    address(holder);
    if (holder === this.signer.classicAddress) throw new Error('Issuer is not a holder');
    if (this.isBanned(holder)) throw new Error('Address is permanently banned by policy');
  }
  approve(holder: string, operationId: string) {
    return this.serial.run(async () => {
      this.allowed(holder); await this.assertConfiguration();
      return this.submitter.submit(operationId, { TransactionType: 'MPTokenAuthorize', Account: this.signer.classicAddress,
        MPTokenIssuanceID: this.id, Holder: holder }, this.signer);
    });
  }
  issue(holder: string, value: string, operationId: string) {
    return this.serial.run(async () => {
      this.allowed(holder); amount(value); await this.assertConfiguration();
      const [issuance, holding] = await Promise.all([this.issuance(), this.holder(holder)]);
      if ((issuance.Flags & 1) !== 0 || (holding && (holding.Flags & 1) !== 0)) throw new Error('Issuance blocked by freeze policy');
      if (!holding || (holding.Flags & 2) === 0) throw new Error('Holder is not authorized');
      return this.submitter.submit(operationId, { TransactionType: 'Payment', Account: this.signer.classicAddress,
        Destination: holder, Amount: { mpt_issuance_id: this.id, value } }, this.signer);
    });
  }
  clawback(holder: string, value: string, operationId: string) {
    return this.serial.run(async () => {
      address(holder); amount(value); await this.assertConfiguration();
      return this.claw(holder, value, operationId);
    });
  }
  private claw(holder: string, value: string, key: string) {
    return this.submitter.submit(key, { TransactionType: 'Clawback', Account: this.signer.classicAddress,
      Holder: holder, Amount: { mpt_issuance_id: this.id, value } }, this.signer);
  }
  private lock(locked: boolean, key: string, holder?: string) {
    return this.submitter.submit(key, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.classicAddress,
      MPTokenIssuanceID: this.id, Flags: locked ? Lock.tfMPTLock : Lock.tfMPTUnlock,
      ...(holder ? { Holder: address(holder) } : {}) }, this.signer);
  }
  setHolderFreeze(holder: string, frozen: boolean, operationId: string) {
    return this.serial.run(async () => {
      if (!frozen) this.allowed(holder);
      await this.assertConfiguration(); return this.lock(frozen, operationId, holder);
    });
  }
  setGlobalFreeze(frozen: boolean, operationId: string) {
    return this.serial.run(async () => { await this.assertConfiguration(); return this.lock(frozen, operationId); });
  }
  /** Resumable multi-transaction workflow. Persist intent, revoke receipt rights, then drain.
   * Redemption remains possible under MPT locks; revocation prevents incoming balance races.
   * A holder deleting/recreating their MPToken cannot restore issuer authorization.
   */
  ban(holder: string, operationId: string): Promise<void> {
    return this.serial.run(async () => {
      address(holder);
      if (holder === this.signer.classicAddress) throw new Error('Cannot ban issuer');
      await this.assertConfiguration();
      const key = this.banKey(holder);
      const existing = this.submitter.store.get<{ operationId: string; complete: boolean }>(key);
      const root = existing?.operationId ?? operationId;
      this.submitter.store.set(key, { operationId: root, complete: false });
      if (await this.holder(holder)) {
        await this.submitter.submit(`${root}:revoke`, { TransactionType: 'MPTokenAuthorize', Account: this.signer.classicAddress,
          MPTokenIssuanceID: this.id, Holder: holder, Flags: Auth.tfMPTUnauthorize }, this.signer);
        const state = await this.holder(holder);
        if (state && BigInt(state.MPTAmount) > 0n) {
          try { await this.claw(holder, MAX_AMOUNT.toString(), `${root}:drain`); }
          catch (error) {
            // A holder may redeem between read and clawback. Only a proven zero balance resolves this race.
            const after = await this.holder(holder);
            if (after && BigInt(after.MPTAmount) !== 0n) throw error;
            if (!(error instanceof LedgerFailure) || error.receipt.code !== 'tecNO_LINE') throw error;
          }
        }
      }
      const final = await this.holder(holder);
      if (final && (BigInt(final.MPTAmount) !== 0n || (final.Flags & 2) !== 0)) throw new Error('Ban postcondition failed');
      this.submitter.store.set(key, { operationId: root, complete: true });
    });
  }
}
