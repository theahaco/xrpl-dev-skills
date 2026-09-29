import {
  type Client, type Payment,
  isValidClassicAddress, MPTokenIssuanceCreateFlags as CreateFlags,
  MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags as AuthFlags,
} from 'xrpl';
import type { MPToken } from 'xrpl/dist/npm/models/ledger/MPToken.js';
import type { MPTokenIssuance } from 'xrpl/dist/npm/models/ledger/MPTokenIssuance.js';
import { FileStore, SerialQueue } from './store.js';
import { isRpcError, requireSuccess, TransactionRunner, type Signer } from './ledger.js';

export const MAX_AMOUNT = 9223372036854775807n;
export const CAPABILITIES = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
  CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export function amount(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 19 || BigInt(value) > MAX_AMOUNT) throw new Error('Amount must be a positive integer string <= 2^63-1 in base units');
  return value;
}
function address(value: string): void {
  if (!isValidClassicAddress(value)) throw new Error('Invalid classic address');
}
export function issuanceId(value: string): string {
  if (!/^[A-Fa-f0-9]{48}$/.test(value)) throw new Error('Invalid MPT issuance ID');
  return value.toUpperCase();
}
interface Ban { reason: string; requestedAt: string; complete: boolean }
interface Policy { issuanceId: string; issuer: string; bans: Record<string, Ban> }
export interface Snapshot {
  ledgerHash: string;
  ledgerIndex: number;
  issuance: MPTokenIssuance;
  holders: Record<string, MPToken | null>;
}

export async function snapshot(client: Client, id: string, holders: readonly string[]): Promise<Snapshot> {
  issuanceId(id);
  holders.forEach(address);
  const ledger = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result;
  if (!ledger.validated) throw new Error('Expected validated ledger');
  const entry = await client.request({ command: 'ledger_entry', mpt_issuance: id, ledger_hash: ledger.ledger_hash });
  if (!entry.result.validated || entry.result.node.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Invalid issuance response');
  const entries = await Promise.all(holders.map(async holder => {
    try {
      const response = await client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: id, account: holder }, ledger_hash: ledger.ledger_hash });
      // xrpl 5.3.0's generic LedgerEntry union omits MPToken despite providing its type.
      const node = response.result.node as unknown as MPToken & { Account: string };
      // rippled omits default-valued MPTAmount at zero, despite the SDK's required type.
      if (node.MPTAmount === undefined) node.MPTAmount = '0';
      if (!response.result.validated || node.LedgerEntryType !== 'MPToken' || node.MPTokenIssuanceID !== id ||
          node.Account !== holder || typeof node.MPTAmount !== 'string' || !/^[0-9]+$/.test(node.MPTAmount) || !Number.isInteger(node.Flags)) throw new Error('Invalid holder response');
      return [holder, node] as const;
    } catch (error) {
      if (isRpcError(error, 'entryNotFound')) return [holder, null] as const;
      throw error;
    }
  }));
  return { ledgerHash: ledger.ledger_hash, ledgerIndex: ledger.ledger_index, issuance: entry.result.node, holders: Object.fromEntries(entries) };
}

/** All amounts are base-unit integer strings. This profile uses AssetScale=0.
 * Native locks exempt payments involving the issuer. This module blocks issuance
 * while locked, but holders can still return value directly to the issuer.
 * One instance, runner and locked store must own all writes for this issuer. */
export class MptIssuer {
  private readonly queue = new SerialQueue();
  private readonly policy: Policy;
  private constructor(readonly id: string, private readonly runner: TransactionRunner,
    private readonly signer: Signer, private readonly store: FileStore) {
    this.policy = store.read<Policy>('policy') ?? { issuanceId: id, issuer: signer.address, bans: {} };
    if (this.policy.issuanceId !== id || this.policy.issuer !== signer.address) throw new Error('Policy store belongs to a different issuer/issuance');
    this.save();
  }

  static async create(runner: TransactionRunner, signer: Signer, store: FileStore, key: string): Promise<MptIssuer> {
    if (store.read<Policy>('policy') && !runner.hasOperation(key)) throw new Error('State directory already manages an issuance');
    const receipt = requireSuccess(await runner.submit(key, {
      TransactionType: 'MPTokenIssuanceCreate', Account: signer.address,
      Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: '1000000000000', TransferFee: 0,
    }, signer));
    if (!('mpt_issuance_id' in receipt.meta) || typeof receipt.meta.mpt_issuance_id !== 'string') throw new Error(`Missing issuance ID in validated create metadata: ${receipt.hash}`);
    const instance = new MptIssuer(issuanceId(receipt.meta.mpt_issuance_id), runner, signer, store);
    await instance.inspect([]);
    return instance;
  }

  static async open(id: string, runner: TransactionRunner, signer: Signer, store: FileStore): Promise<MptIssuer> {
    address(signer.address);
    await runner.preflight();
    if (!store.read<Policy>('policy')) throw new Error('Missing compliance policy: restore durable state before opening an existing issuance');
    const instance = new MptIssuer(issuanceId(id), runner, signer, store);
    await instance.inspect([]);
    return instance;
  }

  async inspect(holders: readonly string[]): Promise<Snapshot> {
    const state = await snapshot(this.runner.client, this.id, holders);
    const token = state.issuance;
    if (token.Issuer !== this.signer.address || !Number.isInteger(token.Flags) || (token.Flags & ~1) !== CAPABILITIES ||
        (token.AssetScale ?? 0) !== 0 || (token.TransferFee ?? 0) !== 0 || token.DomainID) throw new Error('Issuance does not match the restricted compliance profile');
    return state;
  }
  private holder(value: string): void { address(value); if (value === this.signer.address) throw new Error('Issuer is not a holder'); }
  private allowed(holder: string): void { this.holder(holder); if (this.policy.bans[holder]) throw new Error(`Address is permanently banned: ${holder}`); }
  private save(): void { this.store.write('policy', this.policy); }
  isBanned(holder: string): boolean { this.holder(holder); return !!this.policy.bans[holder]; }

  /** Holder signs this separately, without sharing a seed with the issuer backend. */
  enrollment(holder: string) {
    this.holder(holder);
    return { TransactionType: 'MPTokenAuthorize' as const, Account: holder, MPTokenIssuanceID: this.id };
  }

  approve(holder: string, key: string): Promise<void> {
    return this.queue.run(async () => {
      this.allowed(holder);
      const state = await this.inspect([holder]);
      if (!state.holders[holder]) throw new Error('Holder must enroll first');
      requireSuccess(await this.runner.submit(key, { TransactionType: 'MPTokenAuthorize', Account: this.signer.address, MPTokenIssuanceID: this.id, Holder: holder }, this.signer));
      const after = (await this.inspect([holder])).holders[holder];
      if (!after || !(after.Flags & 2)) throw new Error('Authorization postcondition failed');
    });
  }

  issue(holder: string, value: string, key: string): Promise<void> {
    return this.queue.run(async () => {
      this.allowed(holder); amount(value);
      const state = await this.inspect([holder]);
      const holding = state.holders[holder];
      if (!holding || !(holding.Flags & 2) || (holding.Flags & 1) || (state.issuance.Flags & 1)) throw new Error('Issuance blocked: holder unauthorized or token locked');
      requireSuccess(await this.runner.submit(key, this.payment(this.signer.address, holder, value), this.signer));
    });
  }

  payment(from: string, to: string, value: string): Payment {
    address(from); address(to); amount(value);
    return { TransactionType: 'Payment', Account: from, Destination: to, Amount: { mpt_issuance_id: this.id, value } };
  }

  /** Claws back up to value, capped by the available balance by ledger semantics. */
  clawback(holder: string, value: string, key: string): Promise<void> {
    return this.queue.run(async () => {
      this.holder(holder); amount(value); await this.inspect([holder]);
      requireSuccess(await this.runner.submit(key, { TransactionType: 'Clawback', Account: this.signer.address,
        Holder: holder, Amount: { mpt_issuance_id: this.id, value } }, this.signer));
    });
  }

  freezeHolder(holder: string, frozen: boolean, key: string): Promise<void> {
    return this.queue.run(async () => {
      this.holder(holder);
      if (!frozen) this.allowed(holder);
      await this.lock(frozen, key, holder);
    });
  }
  freezeAll(frozen: boolean, key: string): Promise<void> {
    return this.queue.run(() => this.lock(frozen, key));
  }
  private async lock(frozen: boolean, key: string, holder?: string): Promise<void> {
    await this.inspect(holder ? [holder] : []);
    requireSuccess(await this.runner.submit(key, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.address,
      MPTokenIssuanceID: this.id, Flags: frozen ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock,
      ...(holder ? { Holder: holder } : {}),
    }, this.signer));
    const state = await this.inspect(holder ? [holder] : []);
    const flags = holder ? state.holders[holder]?.Flags : state.issuance.Flags;
    if (flags === undefined || Boolean(flags & 1) !== frozen) throw new Error('Lock postcondition failed');
  }

  /** Durable, resumable multi-transaction ban; never reports completion before verification.
   * Revocation first prevents new receipts even if a zero-balance holder deletes/recreates
   * its MPToken. Clawback ignores auth/locks. Escrow/trading/confidential balances are disabled. */
  ban(holder: string, reason: string): Promise<void> {
    return this.queue.run(async () => {
      this.holder(holder);
      if (!reason.trim()) throw new Error('Ban requires an audit reason');
      const previous = this.policy.bans[holder];
      if (previous && previous.reason !== reason) throw new Error('Ban already recorded with a different reason');
      this.policy.bans[holder] ??= { reason, requestedAt: new Date().toISOString(), complete: false };
      this.save(); // Intent survives crashes before any ledger mutation.
      let state = await this.inspect([holder]);
      if (state.holders[holder] || this.runner.hasOperation(`ban/${this.id}/${holder}/revoke`)) {
        const revoke = await this.runner.submit(`ban/${this.id}/${holder}/revoke`, {
          TransactionType: 'MPTokenAuthorize', Account: this.signer.address,
          MPTokenIssuanceID: this.id, Holder: holder, Flags: AuthFlags.tfMPTUnauthorize,
        }, this.signer);
        // A zero-balance holder can delete its entry concurrently. Only accept this
        // terminal race after checking the resulting authorization/balance below.
        if (revoke.code !== 'tecOBJECT_NOT_FOUND') requireSuccess(revoke);
        state = await this.inspect([holder]);
        if (BigInt(state.holders[holder]?.MPTAmount ?? '0') > 0n || this.runner.hasOperation(`ban/${this.id}/${holder}/drain`)) {
          // Maximum instead of a stale read: drains any balance present at execution.
          const drain = await this.runner.submit(`ban/${this.id}/${holder}/drain`, {
            TransactionType: 'Clawback', Account: this.signer.address, Holder: holder,
            Amount: { mpt_issuance_id: this.id, value: MAX_AMOUNT.toString() },
          }, this.signer);
          // Redemption is still allowed after revocation. A concurrent redemption
          // can empty/delete the balance before clawback is validated.
          if (!['tecINSUFFICIENT_FUNDS', 'tecOBJECT_NOT_FOUND'].includes(drain.code)) requireSuccess(drain);
        }
      }
      const after = (await this.inspect([holder])).holders[holder];
      if (after && (BigInt(after.MPTAmount) !== 0n || (after.Flags & 2))) throw new Error('Ban is incomplete; retry after reconciling transactions');
      this.policy.bans[holder]!.complete = true;
      this.save();
    });
  }
}
