import type {
  Client,
  MPTAmount,
  MPTokenIssuanceCreate,
  MPTokenMetadata,
  SubmittableTransaction,
  Wallet,
} from 'xrpl';
import { encodeMPTokenMetadata, validateMPTokenMetadata } from 'xrpl';
import { type AmountInput, MAX_MPT_AMOUNT, parseAmount, parsePositiveAmount } from './amounts.js';
import type { BanRecord, BanRegistry } from './banRegistry.js';
import {
  GlobalFreezeActiveError,
  HolderBannedError,
  HolderFrozenError,
  HolderNotAuthorizedError,
  HolderNotOptedInError,
  InsufficientHolderBalanceError,
  InvalidInputError,
  InvariantViolationError,
  IssuanceConfigurationError,
  TransactionFailedError,
} from './errors.js';
import {
  type HolderLedgerState,
  type IssuanceState,
  IssuanceFlags,
  assertClassicAddress,
  assertIssuanceId,
  readHolder,
  readIssuance,
} from './ledger.js';
import { type Precheck, type SubmittedTransaction, TransactionSubmitter, type SubmitterOptions } from './submitter.js';

// Transaction flag values (xrpl.js exposes these as enums; kept explicit here for auditability).
const tfMPTCanLock = 0x02;
const tfMPTRequireAuth = 0x04;
const tfMPTCanTransfer = 0x20;
const tfMPTCanClawback = 0x40;
const tfMPTUnauthorize = 0x01;
const tfMPTLock = 0x01;
const tfMPTUnlock = 0x02;

/**
 * Capabilities every issuance managed by this module must have:
 *  - RequireAuth: allowlist. Only issuer-approved holders can hold or receive.
 *  - CanLock:     per-holder and global freeze.
 *  - CanClawback: clawback and bans.
 *  - CanTransfer: holders may pay each other (subject to all of the above).
 * On-ledger flags are immutable after creation, so these must be right on day one.
 */
export const REQUIRED_ISSUANCE_FLAGS =
  IssuanceFlags.lsfMPTRequireAuth |
  IssuanceFlags.lsfMPTCanLock |
  IssuanceFlags.lsfMPTCanClawback |
  IssuanceFlags.lsfMPTCanTransfer;

/**
 * Capabilities deliberately left off. Escrow, DEX trading and confidential
 * balances let tokens sit in places (escrows, offers, encrypted balances) that
 * the controls above do not cover in the same way. Enable them only after
 * a compliance review.
 */
export const FORBIDDEN_ISSUANCE_FLAGS =
  IssuanceFlags.lsfMPTCanEscrow | IssuanceFlags.lsfMPTCanTrade | IssuanceFlags.lsfMPTCanHoldConfidentialBalance;

export interface IssuanceConfig {
  /** Display decimals. On-ledger amounts are integers; value = units / 10^assetScale. */
  assetScale: number;
  /** Supply cap in base units. Defaults to the protocol maximum (2^63 - 1). */
  maximumAmount?: AmountInput;
  /** Fee on holder-to-holder transfers, in units of 1/1000 of a percent (0-50000). Default 0. */
  transferFee?: number;
  /** XLS-89 metadata. Stored on ledger, max 1024 bytes once encoded. */
  metadata?: MPTokenMetadata;
}

export type AuditOutcome = 'success' | 'skipped' | 'rejected' | 'failed';

export interface AuditEvent {
  timestamp: string;
  action: string;
  issuanceId: string;
  issuer: string;
  holder?: string;
  amount?: string;
  outcome: AuditOutcome;
  txHash?: string;
  ledgerIndex?: number;
  context?: Record<string, string>;
  error?: { name: string; message: string };
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>;

export interface MptIssuerOptions {
  banRegistry: BanRegistry;
  /**
   * Receives an event for every control action, including rejected and failed
   * attempts. Wire this to durable, append-only storage. If the sink throws,
   * the operation's promise rejects with that error. The on-ledger action (if
   * any) has still happened, so check the ledger before retrying.
   */
  audit?: AuditSink;
  submitter?: SubmitterOptions;
}

export interface OperationResult {
  /** False when the requested state already held and nothing was submitted. */
  changed: boolean;
  txHash?: string;
  ledgerIndex?: number;
}

export interface HolderStatus extends HolderLedgerState {
  banned: boolean;
  ban?: BanRecord;
}

export interface BanResult {
  record: BanRecord;
  transactions: { action: 'unauthorize' | 'clawback'; txHash: string; ledgerIndex: number; amount?: string }[];
  clawedBack: bigint;
  finalState: HolderStatus;
}

const toResult = (tx: SubmittedTransaction | null): OperationResult =>
  tx ? { changed: true, txHash: tx.hash, ledgerIndex: tx.ledgerIndex } : { changed: false };

/**
 * Issuer-side controls for a regulated MPT on the XRP Ledger.
 *
 * All amounts are bigint base units (see amounts.ts). All ledger reads use the
 * latest validated ledger. Every state-changing method either resolves after
 * the transaction is validated with tesSUCCESS, or throws (see errors.ts).
 *
 * Protocol behaviour this module relies on (verified on testnet, rippled 3.4.1):
 *  - RequireAuth: payments to or from a holder without lsfMPTAuthorized fail with
 *    tecNO_AUTH, including payments from the issuer.
 *  - Lock (per-holder or global) blocks holder-to-holder transfers (tecLOCKED),
 *    but NOT issuer-to-holder payments, and NOT holder-to-issuer redemptions.
 *    This module therefore refuses to issue to a frozen holder or while globally
 *    frozen. Redemption back to the issuer during a freeze stays possible on-ledger.
 *  - Clawback works on frozen and unauthorized holders.
 */
export class MptIssuer {
  private readonly submitter: TransactionSubmitter;
  private readonly bans: BanRegistry;
  private readonly auditSink: AuditSink | undefined;

  private constructor(
    private readonly client: Client,
    wallet: Wallet,
    readonly issuanceId: string,
    options: MptIssuerOptions,
    submitter?: TransactionSubmitter,
  ) {
    this.submitter = submitter ?? new TransactionSubmitter(client, wallet, options.submitter);
    this.bans = options.banRegistry;
    this.auditSink = options.audit;
  }

  get issuer(): string {
    return this.submitter.address;
  }

  /**
   * Create a new issuance with all compliance controls enabled, and return a
   * connected MptIssuer for it.
   */
  static async createIssuance(
    client: Client,
    wallet: Wallet,
    config: IssuanceConfig,
    options: MptIssuerOptions,
  ): Promise<MptIssuer> {
    const { assetScale, transferFee = 0, metadata } = config;
    if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 255) {
      throw new InvalidInputError(`assetScale must be an integer in [0, 255], got ${assetScale}`);
    }
    if (!Number.isInteger(transferFee) || transferFee < 0 || transferFee > 50_000) {
      throw new InvalidInputError(`transferFee must be an integer in [0, 50000], got ${transferFee}`);
    }
    const maximumAmount =
      config.maximumAmount === undefined ? MAX_MPT_AMOUNT : parsePositiveAmount(config.maximumAmount, 'maximumAmount');

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      AssetScale: assetScale,
      MaximumAmount: maximumAmount.toString(),
      Flags: tfMPTRequireAuth | tfMPTCanLock | tfMPTCanClawback | tfMPTCanTransfer,
    };
    if (transferFee > 0) tx.TransferFee = transferFee;
    if (metadata) {
      const encoded = encodeMPTokenMetadata(metadata);
      const problems = validateMPTokenMetadata(encoded);
      if (problems.length > 0) throw new InvalidInputError(`Invalid MPT metadata: ${problems.join('; ')}`);
      tx.MPTokenMetadata = encoded;
    }

    const submitter = new TransactionSubmitter(client, wallet, options.submitter);
    const result = await submitter.submit(tx);
    const issuanceId = (result.meta as { mpt_issuance_id?: string }).mpt_issuance_id;
    if (!issuanceId) {
      throw new InvariantViolationError(`MPTokenIssuanceCreate ${result.hash} succeeded but metadata has no mpt_issuance_id`);
    }
    const instance = new MptIssuer(client, wallet, issuanceId, options, submitter);
    await instance.emit({
      action: 'issuance.create',
      outcome: 'success',
      txHash: result.hash,
      ledgerIndex: result.ledgerIndex,
      context: { assetScale: String(assetScale), maximumAmount: maximumAmount.toString(), transferFee: String(transferFee) },
    });
    await instance.verifyIssuance();
    return instance;
  }

  /** Attach to an existing issuance. Verifies ownership and required flags. */
  static async connect(client: Client, wallet: Wallet, issuanceId: string, options: MptIssuerOptions): Promise<MptIssuer> {
    assertIssuanceId(issuanceId);
    const instance = new MptIssuer(client, wallet, issuanceId, options);
    await instance.verifyIssuance();
    return instance;
  }

  /** Check that the on-ledger issuance belongs to this signer and has exactly the intended capabilities. */
  async verifyIssuance(): Promise<IssuanceState> {
    const state = await readIssuance(this.client, this.issuanceId);
    if (state.issuer !== this.issuer) {
      throw new IssuanceConfigurationError(`Issuance ${this.issuanceId} is issued by ${state.issuer}, not ${this.issuer}`);
    }
    const missing = REQUIRED_ISSUANCE_FLAGS & ~state.flags;
    if (missing !== 0) {
      throw new IssuanceConfigurationError(`Issuance is missing required capabilities (flags 0x${missing.toString(16)})`);
    }
    const forbidden = FORBIDDEN_ISSUANCE_FLAGS & state.flags;
    if (forbidden !== 0) {
      throw new IssuanceConfigurationError(`Issuance has capabilities outside the compliance policy (flags 0x${forbidden.toString(16)})`);
    }
    return state;
  }

  // ---------------------------------------------------------------- reads

  getIssuance(): Promise<IssuanceState> {
    return readIssuance(this.client, this.issuanceId);
  }

  async getHolder(address: string): Promise<HolderStatus> {
    assertClassicAddress(address, 'holder');
    const [state, ban] = await Promise.all([
      readHolder(this.client, this.issuanceId, address),
      this.bans.get(this.issuanceId, address),
    ]);
    return ban ? { ...state, banned: true, ban } : { ...state, banned: false };
  }

  listBans(): Promise<BanRecord[]> {
    return this.bans.list(this.issuanceId);
  }

  // ---------------------------------------------------------------- allowlist

  /**
   * Approve a holder (after KYC). The holder must first opt in by submitting
   * their own MPTokenAuthorize. Banned addresses can never be approved.
   */
  authorizeHolder(holder: string, context: { kycReference: string }): Promise<OperationResult> {
    return this.audited('holder.authorize', { holder, context }, async () => {
      this.assertHolderAddress(holder);
      if (!context.kycReference?.trim()) throw new InvalidInputError('kycReference is required to authorize a holder');
      const tx = await this.submitter.submit(
        { TransactionType: 'MPTokenAuthorize', Account: this.issuer, MPTokenIssuanceID: this.issuanceId, Holder: holder },
        async () => {
          await this.assertNotBanned(holder);
          const state = await this.requireOptedIn(holder);
          if (state.authorized) return 'skip';
        },
      );
      return toResult(tx);
    });
  }

  /**
   * Remove a holder from the allowlist. They can no longer send or receive,
   * but keep any balance. Use {@link banHolder} to also remove the balance.
   */
  revokeHolder(holder: string, context: { reason: string }): Promise<OperationResult> {
    return this.audited('holder.revoke', { holder, context }, async () => {
      this.assertHolderAddress(holder);
      return toResult(await this.submitter.submit(this.unauthorizeTx(holder), this.skipUnlessAuthorized(holder)));
    });
  }

  // ---------------------------------------------------------------- issue / clawback

  /** Send newly issued tokens to an approved, non-frozen, non-banned holder. */
  issue(holder: string, amount: AmountInput): Promise<OperationResult> {
    return this.audited('token.issue', { holder, amount }, async () => {
      this.assertHolderAddress(holder);
      const value = parsePositiveAmount(amount);
      const tx = await this.submitter.submit(
        {
          TransactionType: 'Payment',
          Account: this.issuer,
          Destination: holder,
          Amount: this.mpt(value),
        },
        async () => {
          await this.assertNotBanned(holder);
          const [issuance, state] = await Promise.all([this.getIssuance(), this.requireOptedIn(holder)]);
          if (issuance.globallyFrozen) throw new GlobalFreezeActiveError('Token is globally frozen; issuance is suspended');
          if (!state.authorized) throw new HolderNotAuthorizedError(`${holder} is not on the allowlist`, holder);
          if (state.frozen) throw new HolderFrozenError(`${holder} is frozen`, holder);
          const cap = issuance.maximumAmount ?? MAX_MPT_AMOUNT;
          if (issuance.outstandingAmount + value > cap) {
            throw new InvalidInputError(`Issuing ${value} would exceed the supply cap of ${cap} (outstanding ${issuance.outstandingAmount})`);
          }
        },
      );
      if (!tx) throw new InvariantViolationError('issue precheck unexpectedly skipped');
      this.assertDelivered(tx, value);
      return toResult(tx);
    });
  }

  /** Claw back an exact amount. Refuses (rather than silently clamping) if it exceeds the balance. */
  clawback(holder: string, amount: AmountInput, context: { reason: string }): Promise<OperationResult> {
    return this.audited('token.clawback', { holder, amount, context }, async () => {
      this.assertHolderAddress(holder);
      const value = parsePositiveAmount(amount);
      const tx = await this.submitter.submit(this.clawbackTx(holder, value), async () => {
        const state = await this.requireOptedIn(holder);
        if (state.balance < value) {
          throw new InsufficientHolderBalanceError(`${holder} holds ${state.balance}, cannot claw back ${value}`, holder);
        }
      });
      return toResult(tx);
    });
  }

  // ---------------------------------------------------------------- freezes

  /** Freeze one holder. They cannot send or receive (holder-to-holder transfers are blocked on ledger). */
  freezeHolder(holder: string, context: { reason: string }): Promise<OperationResult> {
    return this.setHolderLock('holder.freeze', holder, true, context);
  }

  unfreezeHolder(holder: string, context: { reason: string }): Promise<OperationResult> {
    return this.setHolderLock('holder.unfreeze', holder, false, context);
  }

  /** Freeze all movement of the token. */
  freezeAll(context: { reason: string }): Promise<OperationResult> {
    return this.setGlobalLock('token.freeze_all', true, context);
  }

  unfreezeAll(context: { reason: string }): Promise<OperationResult> {
    return this.setGlobalLock('token.unfreeze_all', false, context);
  }

  // ---------------------------------------------------------------- bans

  /**
   * Ban an address permanently:
   *  1. Durably record the ban (from now on it can never be re-authorized).
   *  2. Wait for already-queued transactions to settle.
   *  3. Remove the address from the on-ledger allowlist. From then on it can
   *     neither send nor receive, including from the issuer.
   *  4. Claw back its entire balance.
   *  5. Verify: not authorized, zero balance.
   *
   * Idempotent and resumable: if interrupted, call again to finish.
   */
  banHolder(holder: string, context: { reason: string }): Promise<BanResult> {
    return this.audited('holder.ban', { holder, context }, async () => {
      this.assertHolderAddress(holder);
      if (!context.reason?.trim()) throw new InvalidInputError('reason is required to ban a holder');

      let record = await this.bans.get(this.issuanceId, holder);
      if (!record) {
        await this.bans.add({
          address: holder,
          issuanceId: this.issuanceId,
          reason: context.reason,
          bannedAt: new Date().toISOString(),
        });
        record = await this.bans.get(this.issuanceId, holder);
        if (!record) throw new InvariantViolationError(`Ban registry did not persist ban for ${holder}`);
      }
      await this.submitter.barrier();

      const transactions: BanResult['transactions'] = [];
      const unauth = await this.submitter.submit(this.unauthorizeTx(holder), this.skipUnlessAuthorized(holder));
      if (unauth) transactions.push({ action: 'unauthorize', txHash: unauth.hash, ledgerIndex: unauth.ledgerIndex });

      // The balance can no longer change except via redemption to the issuer, so this
      // loop normally runs once. It is bounded, and it treats "nothing left" as done.
      let clawedBack = 0n;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { balance } = await readHolder(this.client, this.issuanceId, holder);
        if (balance === 0n) break;
        try {
          const tx = await this.submitter.submit(this.clawbackTx(holder, balance));
          transactions.push({ action: 'clawback', txHash: tx.hash, ledgerIndex: tx.ledgerIndex, amount: balance.toString() });
          clawedBack += balance;
        } catch (error) {
          if (!(error instanceof TransactionFailedError && error.resultCode === 'tecINSUFFICIENT_FUNDS')) throw error;
        }
      }

      const finalState = await this.assertBanEnforced(holder);
      return { record, transactions, clawedBack, finalState };
    });
  }

  /** Throws unless the holder is banned, not authorized and holds zero. */
  async assertBanEnforced(holder: string): Promise<HolderStatus> {
    const state = await this.getHolder(holder);
    if (!state.banned || state.authorized || state.balance !== 0n) {
      throw new InvariantViolationError(
        `Ban not enforced for ${holder}: banned=${state.banned} authorized=${state.authorized} balance=${state.balance}`,
      );
    }
    return state;
  }

  // ---------------------------------------------------------------- internals

  private setHolderLock(action: string, holder: string, lock: boolean, context: { reason: string }): Promise<OperationResult> {
    return this.audited(action, { holder, context }, async () => {
      this.assertHolderAddress(holder);
      const tx = await this.submitter.submit(
        {
          TransactionType: 'MPTokenIssuanceSet',
          Account: this.issuer,
          MPTokenIssuanceID: this.issuanceId,
          Holder: holder,
          Flags: lock ? tfMPTLock : tfMPTUnlock,
        },
        async () => {
          const state = await this.requireOptedIn(holder);
          if (state.frozen === lock) return 'skip';
        },
      );
      return toResult(tx);
    });
  }

  private setGlobalLock(action: string, lock: boolean, context: { reason: string }): Promise<OperationResult> {
    return this.audited(action, { context }, async () => {
      const tx = await this.submitter.submit(
        {
          TransactionType: 'MPTokenIssuanceSet',
          Account: this.issuer,
          MPTokenIssuanceID: this.issuanceId,
          Flags: lock ? tfMPTLock : tfMPTUnlock,
        },
        async () => ((await this.getIssuance()).globallyFrozen === lock ? 'skip' : undefined),
      );
      return toResult(tx);
    });
  }

  private unauthorizeTx(holder: string): SubmittableTransaction {
    return {
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuer,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
      Flags: tfMPTUnauthorize,
    };
  }

  private clawbackTx(holder: string, value: bigint): SubmittableTransaction {
    return { TransactionType: 'Clawback', Account: this.issuer, Holder: holder, Amount: this.mpt(value) };
  }

  private skipUnlessAuthorized(holder: string): Precheck {
    return async () => {
      const state = await readHolder(this.client, this.issuanceId, holder);
      if (!state.authorized) return 'skip';
    };
  }

  private mpt(value: bigint): MPTAmount {
    return { mpt_issuance_id: this.issuanceId, value: value.toString() };
  }

  private assertDelivered(tx: SubmittedTransaction, expected: bigint): void {
    const delivered = tx.meta.delivered_amount as MPTAmount | undefined;
    if (!delivered || delivered.mpt_issuance_id !== this.issuanceId || parseAmount(delivered.value) !== expected) {
      throw new InvariantViolationError(
        `Payment ${tx.hash} delivered ${JSON.stringify(delivered)} instead of ${expected} of ${this.issuanceId}`,
      );
    }
  }

  private assertHolderAddress(holder: string): void {
    assertClassicAddress(holder, 'holder');
    if (holder === this.issuer) throw new InvalidInputError('The issuer cannot be the holder in a compliance action');
  }

  private async assertNotBanned(holder: string): Promise<void> {
    if (await this.bans.get(this.issuanceId, holder)) throw new HolderBannedError(`${holder} is banned`, holder);
  }

  private async requireOptedIn(holder: string): Promise<HolderLedgerState> {
    const state = await readHolder(this.client, this.issuanceId, holder);
    if (!state.optedIn) {
      throw new HolderNotOptedInError(`${holder} has not opted in to ${this.issuanceId} (no MPToken entry)`, holder);
    }
    return state;
  }

  private async audited<T extends OperationResult | BanResult>(
    action: string,
    details: { holder?: string; amount?: AmountInput; context?: Record<string, string> },
    fn: () => Promise<T>,
  ): Promise<T> {
    const base = {
      action,
      ...(details.holder !== undefined && { holder: details.holder }),
      ...(details.amount !== undefined && { amount: String(details.amount) }),
      ...(details.context !== undefined && { context: details.context }),
    };
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const outcome: AuditOutcome = error instanceof TransactionFailedError ? 'failed' : 'rejected';
      await this.emit({
        ...base,
        outcome,
        ...(error instanceof TransactionFailedError && { txHash: error.hash, ledgerIndex: error.ledgerIndex }),
        error: { name: err.name, message: err.message },
      });
      throw error;
    }
    if ('record' in result) {
      await this.emit({ ...base, outcome: 'success', context: { ...details.context, clawedBack: result.clawedBack.toString(), txHashes: result.transactions.map((t) => t.txHash).join(',') } });
    } else {
      await this.emit({
        ...base,
        outcome: result.changed ? 'success' : 'skipped',
        ...(result.txHash !== undefined && { txHash: result.txHash }),
        ...(result.ledgerIndex !== undefined && { ledgerIndex: result.ledgerIndex }),
      });
    }
    return result;
  }

  private async emit(event: Omit<AuditEvent, 'timestamp' | 'issuanceId' | 'issuer'>): Promise<void> {
    await this.auditSink?.({ timestamp: new Date().toISOString(), issuanceId: this.issuanceId, issuer: this.issuer, ...event });
  }
}
