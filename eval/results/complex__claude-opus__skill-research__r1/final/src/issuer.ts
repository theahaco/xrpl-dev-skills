import {
  type Client,
  type MPTokenAuthorize,
  type MPTokenIssuanceCreate,
  type MPTokenIssuanceSet,
  type MPTokenMetadata,
  type Payment,
  type Clawback,
  type Wallet,
  MPTokenAuthorizeFlags,
  MPTokenIssuanceCreateFlags,
  MPTokenIssuanceSetFlags,
  encodeMPTokenMetadata,
  isValidClassicAddress,
  validateMPTokenMetadata,
} from 'xrpl';

import { fromBaseUnits, toBaseUnits } from './amounts.js';
import type { BanRegistry } from './banRegistry.js';
import { ComplianceError } from './errors.js';
import { type HolderTokenState, type IssuanceState, readHolderToken, readIssuance } from './ledger.js';
import { mptBalanceChange } from './meta.js';
import { type SubmittedTransaction, TransactionSubmitter } from './submit.js';

/** One entry in the compliance audit trail, emitted after every ledger change. */
export interface AuditEvent {
  action:
    | 'issuance.created'
    | 'holder.authorized'
    | 'holder.unauthorized'
    | 'holder.frozen'
    | 'holder.unfrozen'
    | 'holder.banned'
    | 'token.issued'
    | 'token.clawedBack'
    | 'token.globallyFrozen'
    | 'token.globallyUnfrozen';
  issuanceId: string;
  holder?: string;
  /** Token amount in display units, where relevant. */
  amount?: string;
  txHash?: string;
  ledgerIndex?: number;
  reason?: string;
  at: string;
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>;

export interface IssuerDependencies {
  /** Durable ban list; see `BanRegistry`. */
  banRegistry: BanRegistry;
  /** Receives an event after each successful ledger change. Failures propagate. */
  audit?: AuditSink;
}

export interface CreateIssuanceOptions {
  /** Decimal places of one token (on-ledger AssetScale). Immutable. */
  assetScale: number;
  /** Optional supply cap, in token units. Immutable. */
  maximumAmount?: string;
  /** XLS-89 token metadata. */
  metadata: MPTokenMetadata;
  /**
   * Allow approved holders to pay each other. When false, holders can only
   * send the token back to the issuer. Default true. Immutable.
   */
  allowHolderTransfers?: boolean;
}

/** Result of a state-changing control. `tx` is absent when nothing needed to change. */
export interface ControlResult {
  changed: boolean;
  tx?: SubmittedTransaction;
}

export interface HolderStatus extends HolderTokenState {
  address: string;
  banned: boolean;
  /** Balance in token units. */
  balance: string;
}

export interface BanResult {
  holder: string;
  /** Amount clawed back as part of the ban, in token units. */
  clawedBack: string;
  transactions: SubmittedTransaction[];
}

/**
 * Capabilities every issuance managed by this module must have. They are
 * set at creation and cannot be added later (DynamicMPT is not enabled on
 * testnet or mainnet as of writing).
 */
const REQUIRED_CAPABILITIES = [
  ['canLock', 'Can Lock (per-holder and global freeze)'],
  ['requireAuth', 'Require Auth (allowlist)'],
  ['canClawback', 'Can Clawback'],
] as const;

/**
 * Capabilities that would let holders move balances somewhere a plain
 * Clawback cannot reach (escrows, AMM pools), breaking "claw back any
 * amount from any holder". Issuances with these enabled are refused.
 */
const FORBIDDEN_CAPABILITIES = [
  ['canEscrow', 'Can Escrow (escrowed balances cannot be clawed back)'],
  ['canTrade', 'Can Trade (AMM-held balances cannot be clawed back with Clawback)'],
] as const;

/**
 * Issuer-side compliance controls for one MPT issuance.
 *
 * Control semantics and where they are enforced:
 * - Allowlist: the issuance has Require Auth, so the ledger rejects any
 *   payment to or from a holder the issuer has not authorized.
 * - Clawback: enforced by the ledger; works regardless of freezes.
 * - Per-holder / global freeze: the ledger blocks every payment between
 *   holders involving a frozen holder (or any holder, when globally frozen).
 *   The ledger still allows the issuer to send to a frozen holder, so this
 *   module refuses to `issue` in that case. The ledger also always lets a
 *   frozen holder return tokens to the issuer (redemption).
 * - Ban: the ban is recorded in the `BanRegistry` first, then the holder is
 *   unauthorized (they can no longer send or receive at all), their entire
 *   balance is clawed back, and their MPToken is frozen. The registry stops
 *   this module from ever re-authorizing them.
 */
export class MptIssuer {
  private readonly submitter: TransactionSubmitter;

  private constructor(
    private readonly client: Client,
    wallet: Wallet,
    readonly issuanceId: string,
    readonly assetScale: number,
    private readonly deps: IssuerDependencies,
  ) {
    this.submitter = new TransactionSubmitter(client, wallet);
  }

  get issuerAddress(): string {
    return this.submitter.address;
  }

  /** Creates a new issuance with every compliance control enabled. */
  static async createIssuance(
    client: Client,
    wallet: Wallet,
    options: CreateIssuanceOptions,
    deps: IssuerDependencies,
  ): Promise<MptIssuer> {
    const metadataHex = encodeMPTokenMetadata(options.metadata);
    const metadataProblems = validateMPTokenMetadata(metadataHex);
    if (metadataProblems.length > 0) {
      throw new ComplianceError('INVALID_INPUT', `Invalid token metadata: ${metadataProblems.join('; ')}`);
    }

    let flags =
      MPTokenIssuanceCreateFlags.tfMPTCanLock |
      MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanClawback;
    if (options.allowHolderTransfers ?? true) flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer;

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      AssetScale: options.assetScale,
      Flags: flags,
      MPTokenMetadata: metadataHex,
    };
    if (options.maximumAmount !== undefined) {
      tx.MaximumAmount = toBaseUnits(options.maximumAmount, options.assetScale).toString();
    } else {
      // Validates assetScale even without a cap.
      toBaseUnits('1', options.assetScale);
    }

    const submitted = await new TransactionSubmitter(client, wallet).submit(tx);
    const issuanceId = (submitted.meta as { mpt_issuance_id?: string }).mpt_issuance_id;
    if (!issuanceId) throw new Error(`MPTokenIssuanceCreate ${submitted.hash} returned no mpt_issuance_id`);

    const issuer = await MptIssuer.load(client, wallet, issuanceId, deps);
    await issuer.emit({ action: 'issuance.created', txHash: submitted.hash, ledgerIndex: submitted.ledgerIndex });
    return issuer;
  }

  /**
   * Attaches to an existing issuance, verifying that `wallet` is its issuer
   * and that it has every required control.
   */
  static async load(client: Client, wallet: Wallet, issuanceId: string, deps: IssuerDependencies): Promise<MptIssuer> {
    if (!/^[0-9A-F]{48}$/i.test(issuanceId)) {
      throw new ComplianceError('INVALID_INPUT', `Invalid MPT issuance ID "${issuanceId}"`);
    }
    const issuance = await readIssuance(client, issuanceId);
    if (!issuance) throw new ComplianceError('INVALID_INPUT', `MPT issuance ${issuanceId} does not exist`);
    if (issuance.issuer !== wallet.classicAddress) {
      throw new ComplianceError('NOT_ISSUER', `${wallet.classicAddress} is not the issuer of ${issuanceId}`);
    }
    const missing = REQUIRED_CAPABILITIES.filter(([key]) => !issuance[key]).map(([, label]) => label);
    const forbidden = FORBIDDEN_CAPABILITIES.filter(([key]) => issuance[key]).map(([, label]) => label);
    if (missing.length > 0 || forbidden.length > 0) {
      throw new ComplianceError(
        'ISSUANCE_MISSING_CONTROLS',
        `Issuance ${issuanceId} cannot provide the required compliance controls` +
          (missing.length ? `; missing: ${missing.join(', ')}` : '') +
          (forbidden.length ? `; incompatible: ${forbidden.join(', ')}` : ''),
      );
    }
    return new MptIssuer(client, wallet, issuanceId, issuance.assetScale, deps);
  }

  // ---------------------------------------------------------------- reads

  async getIssuance(): Promise<IssuanceState> {
    const issuance = await readIssuance(this.client, this.issuanceId);
    if (!issuance) throw new Error(`MPT issuance ${this.issuanceId} no longer exists`);
    return issuance;
  }

  async getHolder(holder: string): Promise<HolderStatus> {
    this.assertHolderAddress(holder);
    const [token, banned] = await Promise.all([
      readHolderToken(this.client, this.issuanceId, holder),
      this.deps.banRegistry.isBanned(holder),
    ]);
    return { ...token, address: holder, banned, balance: fromBaseUnits(token.balanceBaseUnits, this.assetScale) };
  }

  /**
   * True if the ban on `holder` is fully in effect: recorded, and on-ledger
   * the holder is not authorized and holds none of the token.
   */
  async isBanEnforced(holder: string): Promise<boolean> {
    const status = await this.getHolder(holder);
    return status.banned && !status.authorized && status.balanceBaseUnits === 0n && status.escrowedBaseUnits === 0n;
  }

  // ------------------------------------------------------------ allowlist

  /**
   * Approves `holder` (after KYC) to hold the token. The holder must first
   * opt in by submitting their own MPTokenAuthorize. Refuses banned addresses.
   */
  async authorizeHolder(holder: string): Promise<ControlResult> {
    this.assertHolderAddress(holder);
    await this.assertNotBanned(holder);
    const token = await readHolderToken(this.client, this.issuanceId, holder);
    if (!token.optedIn) {
      throw new ComplianceError(
        'HOLDER_NOT_OPTED_IN',
        `${holder} has not opted in to ${this.issuanceId}; the holder must submit MPTokenAuthorize first`,
      );
    }
    if (token.authorized) return { changed: false };

    const tx = await this.submitter.submit<MPTokenAuthorize>({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
    });
    await this.emit({ action: 'holder.authorized', holder, txHash: tx.hash, ledgerIndex: tx.ledgerIndex });
    return { changed: true, tx };
  }

  /** Removes `holder` from the allowlist. They can no longer send or receive the token. */
  async revokeAuthorization(holder: string): Promise<ControlResult> {
    this.assertHolderAddress(holder);
    const token = await readHolderToken(this.client, this.issuanceId, holder);
    if (!token.authorized) return { changed: false };

    const tx = await this.submitter.submit<MPTokenAuthorize>({
      TransactionType: 'MPTokenAuthorize',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    });
    await this.emit({ action: 'holder.unauthorized', holder, txHash: tx.hash, ledgerIndex: tx.ledgerIndex });
    return { changed: true, tx };
  }

  // -------------------------------------------------------------- supply

  /** Sends newly issued tokens (`amount` in token units) to an approved, unfrozen holder. */
  async issue(holder: string, amount: string): Promise<SubmittedTransaction> {
    this.assertHolderAddress(holder);
    const baseUnits = toBaseUnits(amount, this.assetScale);
    await this.assertNotBanned(holder);

    const [issuance, token] = await Promise.all([
      this.getIssuance(),
      readHolderToken(this.client, this.issuanceId, holder),
    ]);
    if (issuance.globallyFrozen) {
      throw new ComplianceError('GLOBALLY_FROZEN', `${this.issuanceId} is globally frozen; issuance is suspended`);
    }
    if (!token.optedIn) throw new ComplianceError('HOLDER_NOT_OPTED_IN', `${holder} has not opted in`);
    if (!token.authorized) throw new ComplianceError('HOLDER_NOT_AUTHORIZED', `${holder} is not approved`);
    if (token.frozen) throw new ComplianceError('HOLDER_FROZEN', `${holder} is frozen`);

    const tx = await this.submitter.submit<Payment>({
      TransactionType: 'Payment',
      Account: this.issuerAddress,
      Destination: holder,
      Amount: { mpt_issuance_id: this.issuanceId, value: baseUnits.toString() },
    });
    await this.emit({ action: 'token.issued', holder, amount, txHash: tx.hash, ledgerIndex: tx.ledgerIndex });
    return tx;
  }

  // ------------------------------------------------------------ clawback

  /**
   * Claws back `amount` (token units) from `holder`, or their entire balance
   * when `amount` is `'all'`. Works whether or not the holder or token is
   * frozen or the holder is authorized. If `amount` exceeds the balance, the
   * whole balance is clawed back. Returns the amount actually clawed back.
   */
  async clawback(
    holder: string,
    amount: string | 'all',
  ): Promise<{ clawedBack: string; tx: SubmittedTransaction }> {
    this.assertHolderAddress(holder);
    const requested = amount === 'all' ? undefined : toBaseUnits(amount, this.assetScale);
    const token = await readHolderToken(this.client, this.issuanceId, holder);
    if (token.balanceBaseUnits === 0n) {
      throw new ComplianceError('NOTHING_TO_CLAW_BACK', `${holder} holds none of ${this.issuanceId}`);
    }
    const baseUnits = requested ?? token.balanceBaseUnits;

    const tx = await this.submitter.submit<Clawback>({
      TransactionType: 'Clawback',
      Account: this.issuerAddress,
      Amount: { mpt_issuance_id: this.issuanceId, value: baseUnits.toString() },
      Holder: holder,
    });
    // The holder's balance was non-zero, so the metadata diff is exact.
    const clawedBack = fromBaseUnits(-mptBalanceChange(tx.meta, this.issuanceId, holder), this.assetScale);
    await this.emit({
      action: 'token.clawedBack',
      holder,
      amount: clawedBack,
      txHash: tx.hash,
      ledgerIndex: tx.ledgerIndex,
    });
    return { clawedBack, tx };
  }

  // -------------------------------------------------------------- freezes

  /** Freezes one holder: they can no longer send to or receive from other holders or be issued tokens. */
  freezeHolder(holder: string): Promise<ControlResult> {
    return this.setHolderFrozen(holder, true);
  }

  unfreezeHolder(holder: string): Promise<ControlResult> {
    return this.setHolderFrozen(holder, false);
  }

  /** Freezes all movement of the token between holders and suspends issuance. */
  freezeAll(): Promise<ControlResult> {
    return this.setGlobalFrozen(true);
  }

  unfreezeAll(): Promise<ControlResult> {
    return this.setGlobalFrozen(false);
  }

  // ----------------------------------------------------------------- bans

  /**
   * Bans `holder`: they end up holding none of the token and can never
   * receive it again. Idempotent and safe to re-run if interrupted; each step
   * is skipped once it has taken effect.
   */
  async banHolder(holder: string, reason: string): Promise<BanResult> {
    this.assertHolderAddress(holder);
    if (!reason.trim()) throw new ComplianceError('INVALID_INPUT', 'A ban reason is required');

    // Record first so that no concurrent call can re-authorize the holder.
    await this.deps.banRegistry.recordBan(holder, reason);
    const transactions: SubmittedTransaction[] = [];
    let clawedBack = 0n;

    const token = await readHolderToken(this.client, this.issuanceId, holder);
    if (token.optedIn) {
      // 1. Unauthorize: from now on the holder cannot send or receive at all,
      //    so their balance cannot move while we claw it back.
      const revoked = await this.revokeAuthorization(holder);
      if (revoked.tx) transactions.push(revoked.tx);

      // 2. Claw back everything.
      if (token.escrowedBaseUnits > 0n) {
        throw new ComplianceError(
          'ESCROWED_BALANCE',
          `${holder} has escrowed balance that Clawback cannot reach; ban is recorded but incomplete`,
        );
      }
      const current = await readHolderToken(this.client, this.issuanceId, holder);
      if (current.balanceBaseUnits > 0n) {
        const result = await this.clawback(holder, 'all');
        clawedBack = -mptBalanceChange(result.tx.meta, this.issuanceId, holder);
        transactions.push(result.tx);
      }

      // 3. Freeze as defence in depth. Done last: once the fixCleanup3_4_0
      //    amendment is enabled, a frozen MPToken also cannot be deleted.
      const frozen = await this.setHolderFrozen(holder, true);
      if (frozen.tx) transactions.push(frozen.tx);
    }

    if (!(await this.isBanEnforced(holder))) {
      throw new Error(`Ban on ${holder} did not take full effect; investigate before retrying`);
    }
    const amount = fromBaseUnits(clawedBack, this.assetScale);
    await this.emit({
      action: 'holder.banned',
      holder,
      amount,
      reason,
      ...(transactions.length > 0 ? { txHash: transactions.at(-1)!.hash } : {}),
    });
    return { holder, clawedBack: amount, transactions };
  }

  // -------------------------------------------------------------- helpers

  private async setHolderFrozen(holder: string, frozen: boolean): Promise<ControlResult> {
    this.assertHolderAddress(holder);
    const token = await readHolderToken(this.client, this.issuanceId, holder);
    if (!token.optedIn) {
      throw new ComplianceError('HOLDER_NOT_OPTED_IN', `${holder} has no MPToken for ${this.issuanceId} to freeze`);
    }
    if (token.frozen === frozen) return { changed: false };

    const tx = await this.submitter.submit<MPTokenIssuanceSet>({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Holder: holder,
      Flags: frozen ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    });
    await this.emit({
      action: frozen ? 'holder.frozen' : 'holder.unfrozen',
      holder,
      txHash: tx.hash,
      ledgerIndex: tx.ledgerIndex,
    });
    return { changed: true, tx };
  }

  private async setGlobalFrozen(frozen: boolean): Promise<ControlResult> {
    const issuance = await this.getIssuance();
    if (issuance.globallyFrozen === frozen) return { changed: false };

    const tx = await this.submitter.submit<MPTokenIssuanceSet>({
      TransactionType: 'MPTokenIssuanceSet',
      Account: this.issuerAddress,
      MPTokenIssuanceID: this.issuanceId,
      Flags: frozen ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
    });
    await this.emit({
      action: frozen ? 'token.globallyFrozen' : 'token.globallyUnfrozen',
      txHash: tx.hash,
      ledgerIndex: tx.ledgerIndex,
    });
    return { changed: true, tx };
  }

  private assertHolderAddress(holder: string): void {
    if (!isValidClassicAddress(holder)) {
      throw new ComplianceError('INVALID_INPUT', `"${holder}" is not a valid classic address`);
    }
    if (holder === this.issuerAddress) {
      throw new ComplianceError('INVALID_INPUT', 'The issuer cannot be a holder of its own token');
    }
  }

  private async assertNotBanned(holder: string): Promise<void> {
    if (await this.deps.banRegistry.isBanned(holder)) {
      throw new ComplianceError('HOLDER_BANNED', `${holder} is banned`);
    }
  }

  private async emit(event: Omit<AuditEvent, 'issuanceId' | 'at'>): Promise<void> {
    await this.deps.audit?.({ ...event, issuanceId: this.issuanceId, at: new Date().toISOString() });
  }
}
