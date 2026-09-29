import {
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  MPTokenAuthorizeFlags,
  RippledError,
  encodeMPTokenMetadata,
  validateMPTokenMetadata,
  decodeAccountID,
  type Client,
  type MPTAmount,
  type MPTokenMetadata,
  type Node,
  type SubmittableTransaction,
  type TransactionMetadata,
  type Wallet,
} from 'xrpl';

import { assertClassicAddress, normalizeIssuanceId, parseAmount, MAX_MPT_AMOUNT, type MptAmount } from './amounts.js';
import {
  ComplianceError,
  InvariantError,
  TransactionExpiredError,
  TransactionFailedError,
  TransactionOutcomeUnknownError,
  ValidationError,
} from './errors.js';
import type { ComplianceRegistry } from './registry.js';
import { requireSuccess, submitAndConfirm, type SubmitOptions, type ValidatedTransaction } from './submit.js';

/** MPToken (per-holder) ledger entry flags. Not exported by xrpl.js. */
const lsfMPTLocked = 0x0000_0001;
const lsfMPTAuthorized = 0x0000_0002;

/** MPTokenIssuance ledger entry flags. Not exported by xrpl.js. */
export enum MPTokenIssuanceFlags {
  lsfMPTLocked = 0x01,
  lsfMPTCanLock = 0x02,
  lsfMPTRequireAuth = 0x04,
  lsfMPTCanEscrow = 0x08,
  lsfMPTCanTrade = 0x10,
  lsfMPTCanTransfer = 0x20,
  lsfMPTCanClawback = 0x40,
  lsfMPTCanHoldConfidentialBalance = 0x80,
}

/**
 * Issuance flags every compliant issuance must have. MPT flags are immutable once
 * the issuance is created, so these are fixed at creation time:
 *  - CanLock:      per-holder and global freeze
 *  - RequireAuth:  allowlist; holders must be individually authorized by the issuer
 *  - CanClawback:  clawback
 *  - CanTransfer:  holder-to-holder transfers (otherwise holders could only redeem to the issuer)
 */
export const REQUIRED_ISSUANCE_FLAGS =
  MPTokenIssuanceFlags.lsfMPTCanLock |
  MPTokenIssuanceFlags.lsfMPTRequireAuth |
  MPTokenIssuanceFlags.lsfMPTCanClawback |
  MPTokenIssuanceFlags.lsfMPTCanTransfer;

/**
 * Flags that must NOT be set. Each lets balances sit somewhere clawback cannot reach
 * (escrows, DEX/AMM, confidential balances), which would break the guarantee that a
 * banned holder ends with zero.
 */
export const FORBIDDEN_ISSUANCE_FLAGS =
  MPTokenIssuanceFlags.lsfMPTCanEscrow |
  MPTokenIssuanceFlags.lsfMPTCanTrade |
  MPTokenIssuanceFlags.lsfMPTCanHoldConfidentialBalance;

const CREATE_FLAGS =
  MPTokenIssuanceCreateFlags.tfMPTCanLock |
  MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
  MPTokenIssuanceCreateFlags.tfMPTCanClawback |
  MPTokenIssuanceCreateFlags.tfMPTCanTransfer;

export interface IssuanceConfig {
  /** Decimal places for display (amounts on the ledger are integers of 10^-scale). Default 0. */
  assetScale?: number;
  /** Supply cap in base units. Default: ledger maximum. */
  maximumAmount?: MptAmount;
  /** Fee on holder-to-holder transfers in units of 1/1000 of a percent (0-50000). Default 0. */
  transferFee?: number;
  /** XLS-89 metadata. Validated strictly; any warning is treated as an error. */
  metadata?: MPTokenMetadata;
}

export interface IssuanceStatus {
  issuanceId: string;
  issuer: string;
  flags: number;
  globallyFrozen: boolean;
  outstandingAmount: bigint;
  maximumAmount: bigint;
  assetScale: number;
  transferFee: number;
}

export interface HolderStatus {
  address: string;
  /** Whether the holder has opted in (an MPToken entry exists). */
  exists: boolean;
  /** On the issuer's allowlist. */
  authorized: boolean;
  /** Individually frozen. (See IssuanceStatus.globallyFrozen for the global freeze.) */
  frozen: boolean;
  balance: bigint;
  /** Amount held in escrow. Always 0 for issuances created by this module. */
  lockedAmount: bigint;
}

export type Operation =
  | 'createIssuance'
  | 'authorizeHolder'
  | 'revokeHolder'
  | 'issue'
  | 'clawback'
  | 'freezeHolder'
  | 'unfreezeHolder'
  | 'freezeGlobal'
  | 'unfreezeGlobal';

/** Emitted for every transaction this module submits, successful or not. Wire it to your audit log. */
export interface AuditEvent {
  operation: Operation;
  issuanceId: string | null;
  holder?: string;
  amount?: string;
  /** Present when the transaction was signed (i.e. always, except for pre-signing failures). */
  hash?: string;
  resultCode?: string;
  ledgerIndex?: number;
  error?: string;
  timestamp: string;
}

export interface IssuerOptions {
  registry: ComplianceRegistry;
  onAudit?: (event: AuditEvent) => void | Promise<void>;
  submit?: SubmitOptions;
}

export interface ClawbackResult extends ValidatedTransaction {
  /** Exact amount removed from the holder, from transaction metadata. */
  clawedBack: bigint;
}

export interface BanResult {
  transactions: ValidatedTransaction[];
  clawedBack: bigint;
  final: HolderStatus;
}

/**
 * Issuer-side controller for a single compliance-controlled MPT issuance.
 *
 * All mutating operations on one instance are serialized, so account sequence
 * numbers never collide. Run at most one instance per issuer account across all
 * processes (or put a distributed lock in front of it).
 *
 * Amounts are in base units (integers, before AssetScale), as bigint or digit strings.
 */
export class MptIssuer {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly client: Client,
    private readonly wallet: Wallet,
    readonly issuanceId: string,
    private readonly options: IssuerOptions,
  ) {}

  get issuerAddress(): string {
    return this.wallet.classicAddress;
  }

  /** Creates a new issuance with all compliance controls enabled and returns a controller for it. */
  static async createIssuance(
    client: Client,
    wallet: Wallet,
    config: IssuanceConfig,
    options: IssuerOptions,
  ): Promise<{ issuer: MptIssuer; transaction: ValidatedTransaction }> {
    const tx: SubmittableTransaction = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      Flags: CREATE_FLAGS,
      AssetScale: validateAssetScale(config.assetScale ?? 0),
    };
    if (config.maximumAmount !== undefined) tx.MaximumAmount = parseAmount(config.maximumAmount).toString();
    if (config.transferFee !== undefined && config.transferFee !== 0) {
      if (!Number.isInteger(config.transferFee) || config.transferFee < 0 || config.transferFee > 50_000) {
        throw new ValidationError(`transferFee must be an integer 0-50000, got ${config.transferFee}`);
      }
      tx.TransferFee = config.transferFee;
    }
    if (config.metadata !== undefined) tx.MPTokenMetadata = encodeMetadata(config.metadata);

    const result = await submitAudited(client, wallet, tx, options, { operation: 'createIssuance', issuanceId: null });
    const issuanceId = extractIssuanceId(result.meta, wallet.classicAddress);
    const issuer = await MptIssuer.connect(client, wallet, issuanceId, options);
    return { issuer, transaction: result };
  }

  /**
   * Returns a controller for an existing issuance, after verifying on the validated
   * ledger that the wallet is its issuer and that its flags support every control.
   */
  static async connect(client: Client, wallet: Wallet, issuanceId: string, options: IssuerOptions): Promise<MptIssuer> {
    const issuer = new MptIssuer(client, wallet, normalizeIssuanceId(issuanceId), options);
    const status = await issuer.getIssuanceStatus();
    if (status.issuer !== wallet.classicAddress) {
      throw new ValidationError(`Issuance ${issuanceId} is issued by ${status.issuer}, not ${wallet.classicAddress}`);
    }
    const missing = REQUIRED_ISSUANCE_FLAGS & ~status.flags;
    if (missing !== 0) throw new ValidationError(`Issuance ${issuanceId} lacks required flags ${flagNames(missing)}`);
    const forbidden = FORBIDDEN_ISSUANCE_FLAGS & status.flags;
    if (forbidden !== 0) {
      throw new ValidationError(`Issuance ${issuanceId} has flags ${flagNames(forbidden)} that let balances escape clawback`);
    }
    return issuer;
  }

  // ---------------------------------------------------------------- reads

  getIssuanceStatus(): Promise<IssuanceStatus> {
    return fetchIssuanceStatus(this.client, this.issuanceId);
  }

  getHolderStatus(holder: string): Promise<HolderStatus> {
    return fetchHolderStatus(this.client, this.issuanceId, holder);
  }

  async isBanned(holder: string): Promise<boolean> {
    assertClassicAddress(holder, 'holder');
    return this.options.registry.isBanned(this.issuanceId, holder);
  }

  // ---------------------------------------------------------------- allowlist

  /**
   * Adds a KYC-approved holder to the allowlist. The holder must already have opted
   * in to the token (submitted their own MPTokenAuthorize). Banned addresses are refused.
   * Returns null if the holder was already authorized.
   */
  authorizeHolder(holder: string): Promise<ValidatedTransaction | null> {
    return this.exclusive(async () => {
      await this.assertEligibleCounterparty(holder);
      const status = await this.requireHolding(holder);
      if (status.authorized) return null;
      return this.submit('authorizeHolder', { TransactionType: 'MPTokenAuthorize', Account: this.issuerAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder }, { holder });
    });
  }

  /**
   * Removes a holder from the allowlist. They can no longer send or receive the
   * token; any balance stays in place (use clawback or ban to remove it).
   * Returns null if the holder was not authorized.
   */
  revokeHolder(holder: string): Promise<ValidatedTransaction | null> {
    return this.exclusive(async () => {
      this.assertNotIssuer(holder);
      const status = await this.getHolderStatus(holder);
      if (!status.authorized) return null;
      return this.revokeUnlocked(holder);
    });
  }

  // ---------------------------------------------------------------- supply

  /** Sends newly issued tokens from the issuer to an authorized, unfrozen, non-banned holder. */
  issue(holder: string, amount: MptAmount): Promise<ValidatedTransaction> {
    const value = parseAmount(amount);
    return this.exclusive(async () => {
      await this.assertEligibleCounterparty(holder);
      const [status, issuance] = await Promise.all([this.requireHolding(holder), this.getIssuanceStatus()]);
      if (!status.authorized) throw new ComplianceError(`Holder ${holder} is not authorized`);
      if (status.frozen) throw new ComplianceError(`Holder ${holder} is frozen`);
      if (issuance.globallyFrozen) throw new ComplianceError('Token is globally frozen');
      if (issuance.outstandingAmount + value > issuance.maximumAmount) {
        throw new ValidationError(`Issuing ${value} would exceed maximum supply ${issuance.maximumAmount}`);
      }
      const mpt: MPTAmount = { mpt_issuance_id: this.issuanceId, value: value.toString() };
      const result = await this.submit('issue', { TransactionType: 'Payment', Account: this.issuerAddress, Destination: holder, Amount: mpt }, { holder, amount: value });
      const delivered = result.meta.delivered_amount;
      if (typeof delivered !== 'object' || !('mpt_issuance_id' in delivered) || delivered.mpt_issuance_id !== this.issuanceId || BigInt(delivered.value) !== value) {
        throw new InvariantError(`Payment ${result.hash} delivered ${JSON.stringify(delivered)}, expected ${value}`);
      }
      return result;
    });
  }

  /**
   * Claws back `amount` from a holder. Works regardless of freeze or allowlist state.
   * Rejects amounts above the holder's current balance rather than letting the ledger
   * silently cap them; use `clawbackAll` to remove the entire balance.
   *
   * `clawedBack` in the result is the exact amount removed, read from the transaction
   * metadata. It can be less than requested only if the holder moved funds between the
   * balance check and validation (e.g. redeemed to the issuer); freeze first to prevent that.
   */
  clawback(holder: string, amount: MptAmount): Promise<ClawbackResult> {
    const value = parseAmount(amount);
    return this.exclusive(async () => {
      this.assertNotIssuer(holder);
      const status = await this.requireHolding(holder);
      if (value > status.balance) {
        throw new ValidationError(`Cannot claw back ${value} from ${holder}: balance is ${status.balance}`);
      }
      return this.clawbackUnlocked(holder, value);
    });
  }

  /** Claws back a holder's entire balance. Returns null if the balance was already zero. */
  clawbackAll(holder: string): Promise<ClawbackResult | null> {
    return this.exclusive(async () => {
      this.assertNotIssuer(holder);
      const status = await this.getHolderStatus(holder);
      if (status.balance === 0n) return null;
      return this.clawbackUnlocked(holder, status.balance);
    });
  }

  // ---------------------------------------------------------------- freezes

  /**
   * Freezes one holder: they can neither send the token to, nor receive it from, other
   * holders or the issuer. Note that XRPL still lets a frozen holder pay the token back
   * to the issuer (redemption); see README "Freeze and redemption".
   */
  freezeHolder(holder: string): Promise<ValidatedTransaction | null> {
    return this.exclusive(async () => {
      this.assertNotIssuer(holder);
      const status = await this.requireHolding(holder);
      if (status.frozen) return null;
      return this.lockUnlocked(holder);
    });
  }

  /** Lifts a per-holder freeze. Refused for banned holders. */
  unfreezeHolder(holder: string): Promise<ValidatedTransaction | null> {
    return this.exclusive(async () => {
      await this.assertEligibleCounterparty(holder);
      const status = await this.requireHolding(holder);
      if (!status.frozen) return null;
      return this.submit(
        'unfreezeHolder',
        { TransactionType: 'MPTokenIssuanceSet', Account: this.issuerAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: MPTokenIssuanceSetFlags.tfMPTUnlock },
        { holder },
      );
    });
  }

  /**
   * Freezes all movement of the token between holders and issuance to holders.
   * Clawback still works; as with per-holder freeze, holders can still redeem to the issuer.
   */
  freezeGlobal(): Promise<ValidatedTransaction | null> {
    return this.exclusive(async () => {
      if ((await this.getIssuanceStatus()).globallyFrozen) return null;
      return this.submit('freezeGlobal', {
        TransactionType: 'MPTokenIssuanceSet',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Flags: MPTokenIssuanceSetFlags.tfMPTLock,
      });
    });
  }

  /** Lifts the global freeze. Per-holder freezes are unaffected. */
  unfreezeGlobal(): Promise<ValidatedTransaction | null> {
    return this.exclusive(async () => {
      if (!(await this.getIssuanceStatus()).globallyFrozen) return null;
      return this.submit('unfreezeGlobal', {
        TransactionType: 'MPTokenIssuanceSet',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Flags: MPTokenIssuanceSetFlags.tfMPTUnlock,
      });
    });
  }

  // ---------------------------------------------------------------- bans

  /**
   * Permanently bans an address from the token:
   *  1. records the ban in the compliance registry (first, so a failure part-way
   *     still blocks re-authorization, issuance and unfreezing);
   *  2. freezes the holder so the balance cannot move while it is being removed;
   *  3. claws back the entire balance;
   *  4. removes the holder from the allowlist, so the ledger rejects any future
   *     transfer to them;
   *  5. re-reads the validated ledger and verifies the end state.
   *
   * Idempotent: safe to call again after a partial failure. If the address never
   * opted in, only step 1 applies; without issuer authorization it can never receive.
   */
  async ban(holder: string, reason: string): Promise<BanResult> {
    this.assertNotIssuer(holder);
    if (!reason.trim()) throw new ValidationError('A ban reason is required');
    await this.options.registry.recordBan({
      issuanceId: this.issuanceId,
      address: holder,
      reason,
      bannedAt: new Date().toISOString(),
    });

    return this.exclusive(async () => {
      const transactions: ValidatedTransaction[] = [];
      let clawedBack = 0n;
      let status = await this.getHolderStatus(holder);
      if (status.exists) {
        // Freeze blocks transfers to/from other holders; revoking blocks everything else,
        // including redemption to the issuer (which XRPL permits for frozen holders).
        // After both, the balance can only change by clawback.
        if (!status.frozen) transactions.push(await this.lockUnlocked(holder));
        if (status.authorized) transactions.push(await this.revokeUnlocked(holder));
        status = await this.getHolderStatus(holder);
        if (status.balance > 0n) {
          const clawback = await this.clawbackUnlocked(holder, status.balance);
          transactions.push(clawback);
          clawedBack = clawback.clawedBack;
        }
        status = await this.getHolderStatus(holder);
        if (status.balance !== 0n || status.lockedAmount !== 0n || status.authorized || !status.frozen) {
          throw new InvariantError(`Ban of ${holder} did not reach the expected state: ${JSON.stringify(status, bigintReplacer)}`);
        }
      }
      return { transactions, clawedBack, final: status };
    });
  }

  // ---------------------------------------------------------------- internals

  private lockUnlocked(holder: string): Promise<ValidatedTransaction> {
    return this.submit(
      'freezeHolder',
      { TransactionType: 'MPTokenIssuanceSet', Account: this.issuerAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: MPTokenIssuanceSetFlags.tfMPTLock },
      { holder },
    );
  }

  private revokeUnlocked(holder: string): Promise<ValidatedTransaction> {
    return this.submit(
      'revokeHolder',
      { TransactionType: 'MPTokenAuthorize', Account: this.issuerAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize },
      { holder },
    );
  }

  private async clawbackUnlocked(holder: string, value: bigint): Promise<ClawbackResult> {
    const mpt: MPTAmount = { mpt_issuance_id: this.issuanceId, value: value.toString() };
    const result = await this.submit('clawback', { TransactionType: 'Clawback', Account: this.issuerAddress, Holder: holder, Amount: mpt }, { holder, amount: value });
    const clawedBack = clawedBackAmount(result.meta, this.issuanceId, holder);
    if (clawedBack <= 0n || clawedBack > value) {
      throw new InvariantError(`Clawback ${result.hash} removed ${clawedBack}, requested ${value}`);
    }
    return { ...result, clawedBack };
  }

  private async requireHolding(holder: string): Promise<HolderStatus> {
    const status = await this.getHolderStatus(holder);
    if (!status.exists) {
      throw new ValidationError(`${holder} has not opted in to ${this.issuanceId} (no MPToken entry)`);
    }
    return status;
  }

  private assertNotIssuer(holder: string): void {
    assertClassicAddress(holder, 'holder');
    if (holder === this.issuerAddress) throw new ValidationError('The issuer cannot be a holder of its own token');
  }

  private async assertEligibleCounterparty(holder: string): Promise<void> {
    this.assertNotIssuer(holder);
    if (await this.options.registry.isBanned(this.issuanceId, holder)) {
      throw new ComplianceError(`${holder} is banned from ${this.issuanceId}`);
    }
  }

  private submit(
    operation: Operation,
    tx: SubmittableTransaction,
    extra: { holder?: string; amount?: bigint } = {},
  ): Promise<ValidatedTransaction> {
    return submitAudited(this.client, this.wallet, tx, this.options, { operation, issuanceId: this.issuanceId, ...extra });
  }

  /** Runs `fn` after every previously queued operation on this instance has settled. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

// ------------------------------------------------------------------ helpers

/** Reads an issuance from the latest validated ledger. */
export async function fetchIssuanceStatus(client: Client, issuanceId: string): Promise<IssuanceStatus> {
  issuanceId = normalizeIssuanceId(issuanceId);
  const res = await client.request({
    command: 'ledger_entry',
    mpt_issuance: issuanceId,
    ledger_index: 'validated',
  });
  const node = res.result.node as unknown as {
    LedgerEntryType: string;
    Issuer: string;
    Flags: number;
    OutstandingAmount?: string;
    MaximumAmount?: string;
    AssetScale?: number;
    TransferFee?: number;
  };
  if (node.LedgerEntryType !== 'MPTokenIssuance') throw new InvariantError(`Unexpected entry type ${node.LedgerEntryType}`);
  return {
    issuanceId: issuanceId,
    issuer: node.Issuer,
    flags: node.Flags,
    globallyFrozen: (node.Flags & MPTokenIssuanceFlags.lsfMPTLocked) !== 0,
    outstandingAmount: BigInt(node.OutstandingAmount ?? '0'),
    maximumAmount: node.MaximumAmount === undefined ? MAX_MPT_AMOUNT : BigInt(node.MaximumAmount),
    assetScale: node.AssetScale ?? 0,
    transferFee: node.TransferFee ?? 0,
  };
}

/** Reads a holder's MPToken entry from the latest validated ledger. */
export async function fetchHolderStatus(client: Client, issuanceId: string, holder: string): Promise<HolderStatus> {
  issuanceId = normalizeIssuanceId(issuanceId);
  assertClassicAddress(holder, 'holder');
  try {
    const res = await client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account: holder },
      ledger_index: 'validated',
    });
    const node = res.result.node as unknown as { Flags: number; MPTAmount?: string; LockedAmount?: string };
    return {
      address: holder,
      exists: true,
      authorized: (node.Flags & lsfMPTAuthorized) !== 0,
      frozen: (node.Flags & lsfMPTLocked) !== 0,
      balance: BigInt(node.MPTAmount ?? '0'),
      lockedAmount: BigInt(node.LockedAmount ?? '0'),
    };
  } catch (err) {
    if (err instanceof RippledError && (err.data as { error?: string } | undefined)?.error === 'entryNotFound') {
      return { address: holder, exists: false, authorized: false, frozen: false, balance: 0n, lockedAmount: 0n };
    }
    throw err;
  }
}

async function submitAudited(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  options: IssuerOptions,
  context: { operation: Operation; issuanceId: string | null; holder?: string; amount?: bigint },
): Promise<ValidatedTransaction> {
  const event: AuditEvent = { operation: context.operation, issuanceId: context.issuanceId, timestamp: '' };
  if (context.holder !== undefined) event.holder = context.holder;
  if (context.amount !== undefined) event.amount = context.amount.toString();
  try {
    const result = requireSuccess(tx.TransactionType, await submitAndConfirm(client, wallet, tx, options.submit));
    Object.assign(event, { hash: result.hash, resultCode: result.resultCode, ledgerIndex: result.ledgerIndex });
    return result;
  } catch (err) {
    event.error = err instanceof Error ? err.message : String(err);
    if (err instanceof TransactionFailedError) {
      event.hash = err.hash;
      event.resultCode = err.resultCode;
      if (err.ledgerIndex !== undefined) event.ledgerIndex = err.ledgerIndex;
    } else if (err instanceof TransactionExpiredError || err instanceof TransactionOutcomeUnknownError) {
      event.hash = err.hash;
    }
    throw err;
  } finally {
    event.timestamp = new Date().toISOString();
    await options.onAudit?.(event);
  }
}

function validateAssetScale(scale: number): number {
  if (!Number.isInteger(scale) || scale < 0 || scale > 19) {
    throw new ValidationError(`assetScale must be an integer 0-19, got ${scale}`);
  }
  return scale;
}

function encodeMetadata(metadata: MPTokenMetadata): string {
  const hex = encodeMPTokenMetadata(metadata);
  const problems = validateMPTokenMetadata(hex);
  if (problems.length > 0) throw new ValidationError(`Invalid MPT metadata:\n${problems.join('\n')}`);
  return hex;
}

/** Reads the new issuance ID from MPTokenIssuanceCreate metadata. */
function extractIssuanceId(meta: TransactionMetadata, issuer: string): string {
  const fromMeta = (meta as { mpt_issuance_id?: string }).mpt_issuance_id;
  if (fromMeta) return normalizeIssuanceId(fromMeta);
  // Fallback: the ID is the issuance's Sequence (uint32 BE) followed by the issuer's AccountID.
  for (const node of meta.AffectedNodes) {
    if ('CreatedNode' in node && node.CreatedNode.LedgerEntryType === 'MPTokenIssuance') {
      const seq = node.CreatedNode.NewFields.Sequence as number;
      return (seq.toString(16).padStart(8, '0') + Buffer.from(decodeAccountID(issuer)).toString('hex')).toUpperCase();
    }
  }
  throw new InvariantError('MPTokenIssuanceCreate metadata contains no issuance');
}

/**
 * Exact amount a Clawback removed from `holder`, from the MPToken node in the metadata.
 * A balance that decreased must have been non-zero before, so PreviousFields.MPTAmount
 * is always present; the final amount is omitted from FinalFields when it reaches zero.
 */
export function clawedBackAmount(meta: TransactionMetadata, issuanceId: string, holder: string): bigint {
  for (const node of meta.AffectedNodes as Node[]) {
    if (!('ModifiedNode' in node)) continue;
    const n = node.ModifiedNode;
    if (n.LedgerEntryType !== 'MPToken') continue;
    const final = n.FinalFields as { Account?: string; MPTokenIssuanceID?: string; MPTAmount?: string } | undefined;
    if (final?.Account !== holder || final.MPTokenIssuanceID?.toUpperCase() !== issuanceId) continue;
    const previous = (n.PreviousFields as { MPTAmount?: string } | undefined)?.MPTAmount;
    if (previous === undefined) return 0n;
    return BigInt(previous) - BigInt(final.MPTAmount ?? '0');
  }
  return 0n;
}

function flagNames(flags: number): string {
  return Object.entries(MPTokenIssuanceFlags)
    .filter(([name, bit]) => typeof bit === 'number' && isNaN(Number(name)) && (flags & bit) !== 0)
    .map(([name]) => name)
    .join(', ');
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
