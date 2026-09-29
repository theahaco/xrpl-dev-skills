import {
  Client,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  type MPTokenIssuanceCreate,
  type MPTokenMetadata,
  type SubmittableTransaction,
  type Wallet,
} from 'xrpl';
import { assertAssetScale, fromRawAmount, MAX_MPT_RAW_AMOUNT, parseRawAmount, toRawAmount } from './amount.js';
import type { BanRecord, BanStore } from './banStore.js';
import {
  InvariantViolationError,
  IssuanceConfigError,
  PolicyViolationError,
  TransactionFailedError,
  ValidationError,
} from './errors.js';
import { JsonLineLogger, type AuditLogger } from './logger.js';
import { submitAndConfirm, type SubmitOptions, type SubmittedTransaction } from './submit.js';

/** Ledger flags on an MPTokenIssuance entry. */
export const IssuanceLedgerFlags = {
  lsfMPTLocked: 0x01,
  lsfMPTCanLock: 0x02,
  lsfMPTRequireAuth: 0x04,
  lsfMPTCanEscrow: 0x08,
  lsfMPTCanTrade: 0x10,
  lsfMPTCanTransfer: 0x20,
  lsfMPTCanClawback: 0x40,
} as const;

/** Ledger flags on a holder's MPToken entry. */
export const HolderLedgerFlags = {
  lsfMPTLocked: 0x01,
  lsfMPTAuthorized: 0x02,
} as const;

/**
 * Capabilities every issuance managed by this module must have. They can only
 * be set at creation time, so an issuance missing any of them can never
 * support the full set of compliance controls.
 */
const REQUIRED_ISSUANCE_FLAGS =
  IssuanceLedgerFlags.lsfMPTCanLock | IssuanceLedgerFlags.lsfMPTRequireAuth | IssuanceLedgerFlags.lsfMPTCanClawback;

/**
 * Capabilities that would let a holder move tokens somewhere clawback can't
 * reach (escrow), which would break the guarantee that a ban leaves the
 * holder with nothing. Issuances with these are refused.
 */
const FORBIDDEN_ISSUANCE_FLAGS = IssuanceLedgerFlags.lsfMPTCanEscrow;

export interface IssuancePolicy {
  /** Decimal places of the token. Immutable after creation. */
  assetScale: number;
  /** Supply cap as a decimal string. Omit for the protocol maximum. */
  maximumAmount?: string;
  /** Allow holder-to-holder transfers. Without this holders can only send back to the issuer. */
  transferable: boolean;
  /** Fee on holder-to-holder transfers in units of 1/1000 of a percent (0-50000). Requires `transferable`. */
  transferFee?: number;
  /** XLS-89 metadata published on ledger. Public — do not include personal data. */
  metadata?: MPTokenMetadata;
}

export interface IssuanceState {
  issuanceId: string;
  issuer: string;
  assetScale: number;
  outstanding: string;
  maximum: string;
  globallyFrozen: boolean;
  capabilities: {
    canLock: boolean;
    requireAuth: boolean;
    canClawback: boolean;
    canTransfer: boolean;
    canEscrow: boolean;
    canTrade: boolean;
  };
  transferFee: number;
}

export interface HolderState {
  address: string;
  /** Whether the holder has an MPToken entry (i.e. has opted in to the token). */
  optedIn: boolean;
  /** On the issuer's allowlist on ledger. */
  authorized: boolean;
  /** Individually frozen. */
  frozen: boolean;
  balance: string;
  rawBalance: bigint;
  /** Recorded in the ban store (independent of on-ledger state). */
  banned: boolean;
}

export interface ActionResult {
  hash: string;
  ledgerIndex: number;
}

export interface BanResult {
  record: BanRecord;
  /** Amount clawed back as part of the ban (decimal string, "0" if none). */
  clawedBack: string;
}

export interface MptIssuerOptions {
  banStore: BanStore;
  logger?: AuditLogger;
  submit?: SubmitOptions;
}

/**
 * Issuer-side controls for a regulated Multi-Purpose Token.
 *
 * All state-changing methods are serialized per instance, check preconditions
 * against the latest validated ledger, and resolve only after the transaction
 * is validated with tesSUCCESS. Run exactly one instance per issuer account;
 * multiple writers sharing a key will contend for sequence numbers and can
 * interleave compound operations such as bans.
 */
export class MptIssuer {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly client: Client,
    private readonly wallet: Wallet,
    readonly issuanceId: string,
    readonly assetScale: number,
    private readonly banStore: BanStore,
    private readonly logger: AuditLogger,
    private readonly submitOptions: SubmitOptions,
  ) {}

  get issuerAddress(): string {
    return this.wallet.classicAddress;
  }

  /**
   * Creates a new issuance with every compliance control enabled
   * (RequireAuth, CanLock, CanClawback) and returns an issuer bound to it.
   */
  static async createIssuance(
    client: Client,
    wallet: Wallet,
    policy: IssuancePolicy,
    options: MptIssuerOptions,
  ): Promise<{ issuer: MptIssuer; tx: ActionResult }> {
    const logger = options.logger ?? new JsonLineLogger();
    assertAssetScale(policy.assetScale);

    const flags =
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback |
      (policy.transferable ? MPTokenIssuanceCreateFlags.tfMPTCanTransfer : 0);

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      AssetScale: policy.assetScale,
      Flags: flags,
    };
    if (policy.maximumAmount !== undefined) {
      tx.MaximumAmount = toRawAmount(policy.maximumAmount, policy.assetScale).toString();
    }
    if (policy.transferFee !== undefined && policy.transferFee !== 0) {
      if (!policy.transferable) {
        throw new ValidationError('transferFee requires transferable: true');
      }
      if (!Number.isInteger(policy.transferFee) || policy.transferFee < 0 || policy.transferFee > 50_000) {
        throw new ValidationError('transferFee must be an integer in [0, 50000]');
      }
      tx.TransferFee = policy.transferFee;
    }
    if (policy.metadata) {
      tx.MPTokenMetadata = encodeMPTokenMetadata(policy.metadata);
    }

    const result = await submitAndConfirm(client, wallet, tx, logger, options.submit);
    const issuanceId = (result.meta as { mpt_issuance_id?: string }).mpt_issuance_id;
    if (!issuanceId) {
      throw new InvariantViolationError(`MPTokenIssuanceCreate ${result.hash} validated but returned no mpt_issuance_id`);
    }
    logger.info('issuance.created', { issuanceId, issuer: wallet.classicAddress, hash: result.hash, flags });

    const issuer = await MptIssuer.load(client, wallet, issuanceId, { ...options, logger });
    return { issuer, tx: { hash: result.hash, ledgerIndex: result.ledgerIndex } };
  }

  /**
   * Binds to an existing issuance, verifying that `wallet` is its issuer and
   * that it has the capabilities required for the compliance controls.
   */
  static async load(client: Client, wallet: Wallet, issuanceId: string, options: MptIssuerOptions): Promise<MptIssuer> {
    if (!/^[0-9A-F]{48}$/i.test(issuanceId)) {
      throw new ValidationError(`Invalid MPT issuance ID: ${issuanceId}`);
    }
    const entry = await fetchIssuance(client, issuanceId);
    if (!entry) {
      throw new IssuanceConfigError(`MPT issuance ${issuanceId} not found in the validated ledger`);
    }
    if (entry.Issuer !== wallet.classicAddress) {
      throw new IssuanceConfigError(`Issuance ${issuanceId} belongs to ${entry.Issuer}, not ${wallet.classicAddress}`);
    }
    if ((entry.Flags & REQUIRED_ISSUANCE_FLAGS) !== REQUIRED_ISSUANCE_FLAGS) {
      throw new IssuanceConfigError(
        `Issuance ${issuanceId} lacks required capabilities (needs CanLock, RequireAuth and CanClawback; flags=0x${entry.Flags.toString(16)})`,
      );
    }
    if ((entry.Flags & FORBIDDEN_ISSUANCE_FLAGS) !== 0) {
      throw new IssuanceConfigError(`Issuance ${issuanceId} allows escrow, which lets holders move tokens beyond clawback`);
    }
    return new MptIssuer(
      client,
      wallet,
      issuanceId.toUpperCase(),
      entry.AssetScale ?? 0,
      options.banStore,
      options.logger ?? new JsonLineLogger(),
      options.submit ?? {},
    );
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async getIssuanceState(): Promise<IssuanceState> {
    const entry = await fetchIssuance(this.client, this.issuanceId);
    if (!entry) {
      throw new IssuanceConfigError(`MPT issuance ${this.issuanceId} no longer exists`);
    }
    const has = (flag: number) => (entry.Flags & flag) !== 0;
    return {
      issuanceId: this.issuanceId,
      issuer: entry.Issuer,
      assetScale: this.assetScale,
      outstanding: fromRawAmount(parseRawAmount(entry.OutstandingAmount), this.assetScale),
      maximum: fromRawAmount(
        entry.MaximumAmount ? parseRawAmount(entry.MaximumAmount) : MAX_MPT_RAW_AMOUNT,
        this.assetScale,
      ),
      globallyFrozen: has(IssuanceLedgerFlags.lsfMPTLocked),
      capabilities: {
        canLock: has(IssuanceLedgerFlags.lsfMPTCanLock),
        requireAuth: has(IssuanceLedgerFlags.lsfMPTRequireAuth),
        canClawback: has(IssuanceLedgerFlags.lsfMPTCanClawback),
        canTransfer: has(IssuanceLedgerFlags.lsfMPTCanTransfer),
        canEscrow: has(IssuanceLedgerFlags.lsfMPTCanEscrow),
        canTrade: has(IssuanceLedgerFlags.lsfMPTCanTrade),
      },
      transferFee: entry.TransferFee ?? 0,
    };
  }

  async getHolderState(address: string): Promise<HolderState> {
    this.assertHolderAddress(address);
    const [entry, ban] = await Promise.all([
      fetchMPToken(this.client, this.issuanceId, address),
      this.banStore.get(this.issuanceId, address),
    ]);
    const rawBalance = parseRawAmount(entry?.MPTAmount);
    const flags = entry?.Flags ?? 0;
    return {
      address,
      optedIn: entry !== undefined,
      authorized: (flags & HolderLedgerFlags.lsfMPTAuthorized) !== 0,
      frozen: (flags & HolderLedgerFlags.lsfMPTLocked) !== 0,
      balance: fromRawAmount(rawBalance, this.assetScale),
      rawBalance,
      banned: ban !== undefined,
    };
  }

  async listBans(): Promise<BanRecord[]> {
    return this.banStore.list(this.issuanceId);
  }

  // ---------------------------------------------------------------------------
  // Allowlist
  // ---------------------------------------------------------------------------

  /**
   * Adds a holder to the allowlist. Call only after KYC approval. The holder
   * must first have opted in to the token (submitted their own
   * MPTokenAuthorize), which creates the ledger entry the issuer approves.
   */
  authorizeHolder(address: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      const holder = await this.getHolderState(address);
      if (holder.banned) {
        throw new PolicyViolationError(`${address} is banned and cannot be re-authorized`);
      }
      if (!holder.optedIn) {
        throw new PolicyViolationError(`${address} has not opted in to ${this.issuanceId} yet`);
      }
      if (holder.authorized) {
        throw new PolicyViolationError(`${address} is already authorized`);
      }
      const result = await this.submit({
        TransactionType: 'MPTokenAuthorize',
        Account: this.issuerAddress,
        MPTokenIssuanceID: this.issuanceId,
        Holder: address,
      });
      this.logger.info('holder.authorized', { issuanceId: this.issuanceId, holder: address, hash: result.hash });
      return result;
    });
  }

  /**
   * Removes a holder from the allowlist without touching their balance. They
   * can no longer send or receive (except back to the issuer via clawback).
   * Use {@link banHolder} to also confiscate the balance.
   */
  revokeHolder(address: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      const holder = await this.getHolderState(address);
      if (!holder.authorized) {
        throw new PolicyViolationError(`${address} is not authorized`);
      }
      const result = await this.unauthorizeTx(address);
      this.logger.info('holder.revoked', { issuanceId: this.issuanceId, holder: address, hash: result.hash });
      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // Issuance and clawback
  // ---------------------------------------------------------------------------

  /** Sends newly issued tokens to an approved, unfrozen holder. */
  issue(address: string, amount: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      const raw = toRawAmount(amount, this.assetScale);
      const [holder, issuance] = await Promise.all([this.getHolderState(address), this.getIssuanceState()]);
      if (holder.banned) {
        throw new PolicyViolationError(`${address} is banned`);
      }
      if (!holder.authorized) {
        throw new PolicyViolationError(`${address} is not on the allowlist`);
      }
      if (holder.frozen) {
        throw new PolicyViolationError(`${address} is frozen`);
      }
      if (issuance.globallyFrozen) {
        throw new PolicyViolationError(`${this.issuanceId} is globally frozen`);
      }
      const outstanding = toRawOrZero(issuance.outstanding, this.assetScale);
      if (outstanding + raw > toRawOrZero(issuance.maximum, this.assetScale)) {
        throw new PolicyViolationError(`Issuing ${amount} would exceed the maximum supply of ${issuance.maximum}`);
      }

      const result = await this.submit({
        TransactionType: 'Payment',
        Account: this.issuerAddress,
        Destination: address,
        Amount: { mpt_issuance_id: this.issuanceId, value: raw.toString() },
      });
      const delivered = deliveredMptAmount(result, this.issuanceId);
      if (delivered !== raw) {
        throw new InvariantViolationError(
          `Payment ${result.hash} delivered ${delivered ?? 'unknown'} raw units, expected ${raw}`,
        );
      }
      this.logger.info('tokens.issued', { issuanceId: this.issuanceId, holder: address, amount, hash: result.hash });
      return result;
    });
  }

  /**
   * Claws back `amount` from a holder. Works regardless of freeze or
   * authorization state. Refuses amounts above the current balance rather
   * than silently clawing back less.
   */
  clawback(address: string, amount: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      const raw = toRawAmount(amount, this.assetScale);
      const holder = await this.getHolderState(address);
      if (raw > holder.rawBalance) {
        throw new PolicyViolationError(`Cannot claw back ${amount} from ${address}: balance is ${holder.balance}`);
      }
      const result = await this.clawbackTx(address, raw);
      this.logger.info('tokens.clawed_back', { issuanceId: this.issuanceId, holder: address, amount, hash: result.hash });
      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // Freezes
  // ---------------------------------------------------------------------------

  /**
   * Freezes one holder: they can neither send nor receive the token.
   *
   * The ledger rejects transfers to and from a frozen holder with tecLOCKED,
   * but it does NOT block payments from the issuer itself (verified on
   * testnet, rippled 3.4.1). Issuer-originated payments to a frozen holder
   * are blocked by {@link issue}'s policy check, so every issuance must go
   * through this module. Clawback still works on a frozen holder.
   */
  freezeHolder(address: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      const holder = await this.getHolderState(address);
      if (!holder.optedIn) {
        throw new PolicyViolationError(`${address} holds no MPToken entry to freeze`);
      }
      if (holder.frozen) {
        throw new PolicyViolationError(`${address} is already frozen`);
      }
      const result = await this.setLockTx(true, address);
      this.logger.info('holder.frozen', { issuanceId: this.issuanceId, holder: address, hash: result.hash });
      return result;
    });
  }

  /** Lifts an individual freeze. Banned holders stay frozen. */
  unfreezeHolder(address: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      const holder = await this.getHolderState(address);
      if (holder.banned) {
        throw new PolicyViolationError(`${address} is banned and cannot be unfrozen`);
      }
      if (!holder.frozen) {
        throw new PolicyViolationError(`${address} is not frozen`);
      }
      const result = await this.setLockTx(false, address);
      this.logger.info('holder.unfrozen', { issuanceId: this.issuanceId, holder: address, hash: result.hash });
      return result;
    });
  }

  /**
   * Freezes all movement of the token. The ledger rejects every
   * holder-originated transfer with tecLOCKED; as with individual freezes it
   * does NOT block issuer payments, which {@link issue} refuses while frozen.
   * Clawback remains available during a global freeze.
   */
  freezeAll(): Promise<ActionResult> {
    return this.exclusive(async () => {
      if ((await this.getIssuanceState()).globallyFrozen) {
        throw new PolicyViolationError(`${this.issuanceId} is already globally frozen`);
      }
      const result = await this.setLockTx(true);
      this.logger.warn('issuance.frozen', { issuanceId: this.issuanceId, hash: result.hash });
      return result;
    });
  }

  /** Lifts a global freeze. Individual holder freezes are unaffected. */
  unfreezeAll(): Promise<ActionResult> {
    return this.exclusive(async () => {
      if (!(await this.getIssuanceState()).globallyFrozen) {
        throw new PolicyViolationError(`${this.issuanceId} is not globally frozen`);
      }
      const result = await this.setLockTx(false);
      this.logger.warn('issuance.unfrozen', { issuanceId: this.issuanceId, hash: result.hash });
      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // Bans
  // ---------------------------------------------------------------------------

  /**
   * Bans an address permanently:
   *
   *  1. Records the ban durably first, so this module refuses to authorize,
   *     issue to or unfreeze the address even if a later step fails.
   *  2. Freezes the holder, so their balance can't move while we act.
   *  3. Claws back their entire balance.
   *  4. Removes them from the on-ledger allowlist, so the ledger itself
   *     rejects any future transfer to them.
   *  5. Re-reads the ledger and verifies all of the above.
   *
   * Idempotent: if interrupted, calling it again completes the remaining steps.
   */
  banHolder(address: string, reason: string): Promise<BanResult> {
    return this.exclusive(async () => {
      this.assertHolderAddress(address);
      if (!reason.trim()) {
        throw new ValidationError('A ban reason is required for the audit trail');
      }

      const record: BanRecord = (await this.banStore.get(this.issuanceId, address)) ?? {
        address,
        issuanceId: this.issuanceId,
        reason,
        bannedAt: new Date().toISOString(),
        txHashes: [],
      };
      await this.banStore.put(record);
      this.logger.warn('holder.ban_started', { issuanceId: this.issuanceId, holder: address, reason: record.reason });

      let clawedBack = 0n;
      let holder = await this.getHolderState(address);
      if (holder.optedIn) {
        if (!holder.frozen) {
          record.txHashes.push((await this.setLockTx(true, address)).hash);
          await this.banStore.put(record);
          holder = await this.getHolderState(address);
        }
        if (holder.rawBalance > 0n) {
          // The holder is frozen, so this balance can't change underneath us.
          clawedBack = holder.rawBalance;
          record.txHashes.push((await this.clawbackTx(address, holder.rawBalance)).hash);
          await this.banStore.put(record);
        }
        if (holder.authorized) {
          record.txHashes.push((await this.unauthorizeTx(address)).hash);
          await this.banStore.put(record);
        }
      }

      const final = await this.getHolderState(address);
      if (final.optedIn && (final.rawBalance !== 0n || final.authorized || !final.frozen)) {
        throw new InvariantViolationError(
          `Ban of ${address} incomplete: balance=${final.balance} authorized=${final.authorized} frozen=${final.frozen}`,
        );
      }
      record.enforcedAt = new Date().toISOString();
      await this.banStore.put(record);
      this.logger.warn('holder.banned', {
        issuanceId: this.issuanceId,
        holder: address,
        reason: record.reason,
        clawedBack: fromRawAmount(clawedBack, this.assetScale),
        hashes: record.txHashes,
      });
      return { record, clawedBack: fromRawAmount(clawedBack, this.assetScale) };
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private clawbackTx(address: string, raw: bigint): Promise<ActionResult> {
    return this.submit({
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Holder: address,
      Amount: { mpt_issuance_id: this.issuanceId, value: raw.toString() },
    });
  }

  private unauthorizeTx(address: string): Promise<ActionResult> {
    return this.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: address,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    });
  }

  private setLockTx(lock: boolean, holder?: string): Promise<ActionResult> {
    return this.submit({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
      ...(holder ? { Holder: holder } : {}),
    });
  }

  private async submit(tx: SubmittableTransaction): Promise<ActionResult & Pick<SubmittedTransaction, 'meta'>> {
    try {
      const { hash, ledgerIndex, meta } = await submitAndConfirm(this.client, this.wallet, tx, this.logger, this.submitOptions);
      return { hash, ledgerIndex, meta };
    } catch (error) {
      if (error instanceof TransactionFailedError) {
        this.logger.error('tx.failed', { type: tx.TransactionType, engineResult: error.engineResult, hash: error.hash });
      }
      throw error;
    }
  }

  private assertHolderAddress(address: string): void {
    if (!isValidClassicAddress(address)) {
      throw new ValidationError(`Invalid classic address: ${address}`);
    }
    if (address === this.issuerAddress) {
      throw new ValidationError('The issuer cannot be a holder of its own token');
    }
  }

  /** Runs `fn` after every previously queued operation on this instance has settled. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
}

// -----------------------------------------------------------------------------
// Ledger helpers
// -----------------------------------------------------------------------------

interface IssuanceEntry {
  Issuer: string;
  Flags: number;
  AssetScale?: number;
  MaximumAmount?: string;
  OutstandingAmount?: string;
  TransferFee?: number;
}

interface MPTokenEntry {
  Flags: number;
  MPTAmount?: string;
}

async function fetchIssuance(client: Client, issuanceId: string): Promise<IssuanceEntry | undefined> {
  return fetchEntry<IssuanceEntry>(client, { mpt_issuance: issuanceId });
}

async function fetchMPToken(client: Client, issuanceId: string, account: string): Promise<MPTokenEntry | undefined> {
  return fetchEntry<MPTokenEntry>(client, { mptoken: { mpt_issuance_id: issuanceId, account } });
}

async function fetchEntry<T>(client: Client, selector: Record<string, unknown>): Promise<T | undefined> {
  try {
    const response = await client.request({ command: 'ledger_entry', ledger_index: 'validated', ...selector });
    return response.result.node as T;
  } catch (error) {
    if ((error as { data?: { error?: string } }).data?.error === 'entryNotFound') {
      return undefined;
    }
    throw error;
  }
}

function deliveredMptAmount(result: { meta: SubmittedTransaction['meta'] }, issuanceId: string): bigint | undefined {
  const delivered = (result.meta as { delivered_amount?: unknown }).delivered_amount;
  if (typeof delivered === 'object' && delivered !== null) {
    const { mpt_issuance_id, value } = delivered as { mpt_issuance_id?: string; value?: string };
    if (mpt_issuance_id?.toUpperCase() === issuanceId && value !== undefined) {
      return parseRawAmount(value);
    }
  }
  return undefined;
}

function toRawOrZero(amount: string, scale: number): bigint {
  return amount === '0' ? 0n : toRawAmount(amount, scale);
}
