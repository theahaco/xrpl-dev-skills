import { LedgerEntry, MPTokenAuthorizeFlags, MPTokenIssuanceCreateFlags, MPTokenIssuanceSetFlags, encodeMPTokenMetadata, isValidClassicAddress, validateMPTokenMetadata, } from 'xrpl';
import { MAX_MPT_AMOUNT, fromBaseUnits, toBaseUnits } from './amounts.js';
import { ComplianceError } from './errors.js';
import { assertAmendmentsEnabled, mptBalanceDelta, readValidatedEntry, submitAndRequireSuccess, } from './ledger.js';
const { MPTokenIssuanceFlags } = LedgerEntry;
/** `MPToken` ledger-entry flags (not exported by xrpl.js). */
const lsfMPTLocked = 0x00000001;
const lsfMPTAuthorized = 0x00000002;
/** Amendments the issuer's controls depend on. */
export const REQUIRED_AMENDMENTS = ['MPTokensV1', 'Clawback'];
/** Issuance capabilities every compliance control relies on. */
const REQUIRED_CAPABILITIES = MPTokenIssuanceFlags.lsfMPTCanLock | MPTokenIssuanceFlags.lsfMPTRequireAuth | MPTokenIssuanceFlags.lsfMPTCanClawback;
/**
 * Capabilities that would let holders move balances somewhere the issuer
 * can't claw back from: escrow (tracked as `LockedAmount`), the DEX/AMM, or
 * confidential balances. A ban could not guarantee a zero holding if any of
 * these were enabled, so the module refuses to manage such an issuance.
 */
const FORBIDDEN_CAPABILITIES = MPTokenIssuanceFlags.lsfMPTCanEscrow |
    MPTokenIssuanceFlags.lsfMPTCanTrade |
    MPTokenIssuanceFlags.lsfMPTCanHoldConfidentialBalance;
const silentLogger = { info: () => undefined, warn: () => undefined };
/**
 * Issuer-side compliance controls for one MPT issuance.
 *
 * Controls and how each is enforced:
 * - Allowlist: the issuance has Require Auth, so the ledger rejects any
 *   payment to or from a holder the issuer hasn't approved.
 * - Clawback: `Clawback` works on locked and unauthorized holders too.
 * - Ban: revoke approval, lock, claw back the whole balance, then re-read the
 *   ledger to confirm the holder holds nothing. The ban is recorded in the
 *   `BanRegistry` first, so an interrupted ban can be re-run safely and the
 *   address can never be approved again.
 * - Per-holder and global freeze: the ledger then blocks all holder-to-holder
 *   transfers involving the frozen balance. The ledger still lets the issuer
 *   pay a frozen holder, so `issue()` refuses to do that itself.
 *
 * Every method re-reads validated ledger state before acting and is
 * idempotent: repeating a call that already took effect does nothing.
 */
export class MptIssuer {
    deps;
    issuanceId;
    assetScale;
    constructor(deps, issuanceId, assetScale) {
        this.deps = deps;
        this.issuanceId = issuanceId;
        this.assetScale = assetScale;
    }
    get issuerAddress() {
        return this.deps.issuerWallet.classicAddress;
    }
    /** Creates a new issuance with every compliance control enabled, and returns a manager for it. */
    static async createIssuance(deps, options) {
        await preflight(deps);
        const { assetScale } = options;
        if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > 19) {
            throw new ComplianceError('INVALID_ARGUMENT', 'assetScale must be an integer between 0 and 19');
        }
        const allowTransfers = options.allowHolderTransfers ?? true;
        const transferFee = options.transferFee ?? 0;
        if (!Number.isInteger(transferFee) || transferFee < 0 || transferFee > 50_000) {
            throw new ComplianceError('INVALID_ARGUMENT', 'transferFee must be an integer between 0 and 50000');
        }
        if (transferFee > 0 && !allowTransfers) {
            throw new ComplianceError('INVALID_ARGUMENT', 'transferFee requires allowHolderTransfers');
        }
        let flags = MPTokenIssuanceCreateFlags.tfMPTCanLock |
            MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
            MPTokenIssuanceCreateFlags.tfMPTCanClawback;
        if (allowTransfers)
            flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer;
        const tx = {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: deps.issuerWallet.classicAddress,
            AssetScale: assetScale,
            Flags: flags,
        };
        if (transferFee > 0)
            tx.TransferFee = transferFee;
        if (options.maximumAmount !== undefined) {
            tx.MaximumAmount = toBaseUnits(options.maximumAmount, assetScale).toString();
        }
        if (options.metadata) {
            const hex = encodeMPTokenMetadata(options.metadata);
            const problems = validateMPTokenMetadata(hex);
            if (problems.length > 0) {
                throw new ComplianceError('ISSUANCE_MISCONFIGURED', `Invalid MPT metadata: ${problems.join('; ')}`);
            }
            tx.MPTokenMetadata = hex;
        }
        const outcome = await submitAndRequireSuccess(deps.client, deps.issuerWallet, tx);
        const issuanceId = outcome.meta.mpt_issuance_id;
        if (!issuanceId)
            throw new Error(`MPTokenIssuanceCreate ${outcome.hash} metadata has no mpt_issuance_id`);
        (deps.logger ?? silentLogger).info('Created MPT issuance', { issuanceId, tx: outcome.hash });
        return MptIssuer.load(deps, issuanceId);
    }
    /** Attaches to an existing issuance after checking that it is ours and has the required controls. */
    static async load(deps, issuanceId) {
        await preflight(deps);
        const raw = await readValidatedEntry(deps.client, { mpt_issuance: issuanceId });
        if (!raw)
            throw new ComplianceError('ISSUANCE_MISCONFIGURED', `MPT issuance ${issuanceId} not found`);
        if (raw.Issuer !== deps.issuerWallet.classicAddress) {
            throw new ComplianceError('ISSUANCE_MISCONFIGURED', `MPT issuance ${issuanceId} is issued by ${raw.Issuer}, not by this wallet`);
        }
        assertSafeCapabilities(issuanceId, raw.Flags);
        return new MptIssuer({ ...deps, logger: deps.logger ?? silentLogger }, issuanceId, raw.AssetScale ?? 0);
    }
    // ---------------------------------------------------------------- reads
    async getIssuanceState() {
        const raw = await readValidatedEntry(this.deps.client, { mpt_issuance: this.issuanceId });
        if (!raw)
            throw new ComplianceError('ISSUANCE_MISCONFIGURED', `MPT issuance ${this.issuanceId} not found`);
        assertSafeCapabilities(this.issuanceId, raw.Flags);
        const has = (flag) => (raw.Flags & flag) !== 0;
        return {
            issuanceId: this.issuanceId,
            issuer: raw.Issuer,
            assetScale: this.assetScale,
            outstanding: fromBaseUnits(BigInt(raw.OutstandingAmount ?? '0'), this.assetScale),
            maximum: fromBaseUnits(raw.MaximumAmount !== undefined ? BigInt(raw.MaximumAmount) : MAX_MPT_AMOUNT, this.assetScale),
            globallyFrozen: has(MPTokenIssuanceFlags.lsfMPTLocked),
            canLock: has(MPTokenIssuanceFlags.lsfMPTCanLock),
            requireAuth: has(MPTokenIssuanceFlags.lsfMPTRequireAuth),
            canClawback: has(MPTokenIssuanceFlags.lsfMPTCanClawback),
            canTransfer: has(MPTokenIssuanceFlags.lsfMPTCanTransfer),
            canEscrow: has(MPTokenIssuanceFlags.lsfMPTCanEscrow),
            canTrade: has(MPTokenIssuanceFlags.lsfMPTCanTrade),
            flags: raw.Flags,
        };
    }
    async getHolderState(holder) {
        this.assertHolderAddress(holder);
        const raw = await this.readMPToken(holder);
        return {
            address: holder,
            optedIn: raw !== undefined,
            authorized: raw !== undefined && (raw.Flags & lsfMPTAuthorized) !== 0,
            frozen: raw !== undefined && (raw.Flags & lsfMPTLocked) !== 0,
            balance: fromBaseUnits(BigInt(raw?.MPTAmount ?? '0'), this.assetScale),
            lockedAmount: fromBaseUnits(BigInt(raw?.LockedAmount ?? '0'), this.assetScale),
            hasConfidentialBalance: raw?.ConfidentialBalanceInbox !== undefined || raw?.ConfidentialBalanceSpending !== undefined,
        };
    }
    async isBanned(holder) {
        return this.deps.banRegistry.isBanned(holder);
    }
    // ------------------------------------------------------------ allowlist
    /**
     * Approves a holder (after KYC) to hold the token. The holder must first opt
     * in by sending their own `MPTokenAuthorize`. Refuses banned addresses.
     */
    async authorizeHolder(holder) {
        await this.assertNotBanned(holder);
        const state = await this.getHolderState(holder);
        if (!state.optedIn) {
            throw new ComplianceError('HOLDER_NOT_OPTED_IN', `${holder} must submit MPTokenAuthorize for ${this.issuanceId} before it can be approved`);
        }
        if (state.authorized)
            return undefined;
        const outcome = await this.submit({
            TransactionType: 'MPTokenAuthorize',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holder,
        });
        this.deps.logger.info('Authorized holder', { holder, tx: outcome.hash });
        return outcome;
    }
    /** Revokes a holder's approval. They can then neither send nor receive the token; their balance stays put. */
    async revokeHolder(holder) {
        const state = await this.getHolderState(holder);
        if (!state.optedIn || !state.authorized)
            return undefined;
        const outcome = await this.submit({
            TransactionType: 'MPTokenAuthorize',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holder,
            Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
        });
        this.deps.logger.info('Revoked holder authorization', { holder, tx: outcome.hash });
        return outcome;
    }
    // ------------------------------------------------------------- issuance
    /** Sends newly issued tokens to an approved, unfrozen holder. */
    async issue(holder, amount) {
        const raw = toBaseUnits(amount, this.assetScale);
        await this.assertNotBanned(holder);
        const [issuance, state] = await Promise.all([this.getIssuanceState(), this.getHolderState(holder)]);
        if (issuance.globallyFrozen) {
            throw new ComplianceError('GLOBALLY_FROZEN', `The token is globally frozen; not issuing to ${holder}`);
        }
        if (!state.optedIn)
            throw new ComplianceError('HOLDER_NOT_OPTED_IN', `${holder} has not opted in to hold the token`);
        if (!state.authorized)
            throw new ComplianceError('HOLDER_NOT_AUTHORIZED', `${holder} is not approved to hold the token`);
        if (state.frozen)
            throw new ComplianceError('HOLDER_FROZEN', `${holder} is frozen; not issuing to them`);
        const outcome = await this.submit({
            TransactionType: 'Payment',
            Account: this.issuerAddress,
            Destination: holder,
            Amount: { mpt_issuance_id: this.issuanceId, value: raw.toString() },
        });
        const delivered = outcome.meta.delivered_amount;
        if (typeof delivered !== 'object' || !('mpt_issuance_id' in delivered) || BigInt(delivered.value) !== raw) {
            throw new Error(`Payment ${outcome.hash} delivered ${JSON.stringify(delivered)}, expected ${raw} base units`);
        }
        this.deps.logger.info('Issued tokens', { holder, amount, tx: outcome.hash });
        return outcome;
    }
    // ------------------------------------------------------------- clawback
    /**
     * Claws back `amount` (display units) from a holder, or their whole balance
     * with `'all'`. Refuses amounts above the balance rather than quietly
     * clawing back less. Returns the amount actually clawed back.
     */
    async clawback(holder, amount) {
        this.assertHolderAddress(holder);
        const balance = BigInt((await this.readMPToken(holder))?.MPTAmount ?? '0');
        let raw;
        if (amount === 'all') {
            if (balance === 0n)
                return { clawedBack: '0', outcome: undefined };
            raw = balance;
        }
        else {
            raw = toBaseUnits(amount, this.assetScale);
            if (raw > balance) {
                throw new ComplianceError('INSUFFICIENT_BALANCE', `${holder} holds ${fromBaseUnits(balance, this.assetScale)}, cannot claw back ${amount}`);
            }
        }
        const outcome = await this.submit({
            TransactionType: 'Clawback',
            Account: this.issuerAddress,
            Holder: holder,
            Amount: { mpt_issuance_id: this.issuanceId, value: raw.toString() },
        });
        const clawedBack = fromBaseUnits(-mptBalanceDelta(outcome.meta, this.issuanceId, holder), this.assetScale);
        this.deps.logger.info('Clawed back tokens', { holder, requested: amount, clawedBack, tx: outcome.hash });
        return { clawedBack, outcome };
    }
    // --------------------------------------------------------------- freeze
    /** Freezes one holder: they can no longer send the token to, or receive it from, other holders. */
    async freezeHolder(holder) {
        const state = await this.getHolderState(holder);
        if (!state.optedIn)
            throw new ComplianceError('HOLDER_NOT_OPTED_IN', `${holder} has no MPToken to freeze`);
        if (state.frozen)
            return undefined;
        const outcome = await this.submit({
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holder,
            Flags: MPTokenIssuanceSetFlags.tfMPTLock,
        });
        this.deps.logger.info('Froze holder', { holder, tx: outcome.hash });
        return outcome;
    }
    /** Unfreezes one holder. A banned holder stays frozen. */
    async unfreezeHolder(holder) {
        await this.assertNotBanned(holder);
        const state = await this.getHolderState(holder);
        if (!state.optedIn || !state.frozen)
            return undefined;
        const outcome = await this.submit({
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holder,
            Flags: MPTokenIssuanceSetFlags.tfMPTUnlock,
        });
        this.deps.logger.info('Unfroze holder', { holder, tx: outcome.hash });
        return outcome;
    }
    /** Freezes all transfers of the token between holders, e.g. during an incident. */
    async freezeAll() {
        if ((await this.getIssuanceState()).globallyFrozen)
            return undefined;
        const outcome = await this.submit({
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Flags: MPTokenIssuanceSetFlags.tfMPTLock,
        });
        this.deps.logger.warn('Globally froze token', { tx: outcome.hash });
        return outcome;
    }
    /** Lifts a global freeze. Per-holder freezes stay in place. */
    async unfreezeAll() {
        if (!(await this.getIssuanceState()).globallyFrozen)
            return undefined;
        const outcome = await this.submit({
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Flags: MPTokenIssuanceSetFlags.tfMPTUnlock,
        });
        this.deps.logger.warn('Lifted global freeze', { tx: outcome.hash });
        return outcome;
    }
    // ------------------------------------------------------------------ ban
    /**
     * Bans an address. When this resolves, the ledger shows the address holding
     * none of the token, unauthorized and frozen, and the registry will never
     * let it be approved again. If interrupted, call it again to finish.
     *
     * Steps, in order:
     * 1. Record the ban, so the address can't be re-approved even if a later step fails.
     * 2. Revoke approval. The ledger then rejects any payment to or from the holder.
     * 3. Freeze the holder.
     * 4. Claw back the entire balance.
     * 5. Re-read validated state and confirm steps 2-4 took effect.
     */
    async ban(holder, reason) {
        this.assertHolderAddress(holder);
        if (reason.trim().length === 0)
            throw new ComplianceError('INVALID_ARGUMENT', 'A ban needs a reason for the audit trail');
        await this.deps.banRegistry.add({ address: holder, reason, bannedAt: new Date().toISOString() });
        const record = (await this.deps.banRegistry.get(holder));
        const transactions = [];
        this.deps.logger.warn('Banning holder', { holder, reason });
        const revoked = await this.revokeHolder(holder);
        if (revoked)
            transactions.push(revoked.hash);
        let state = await this.getHolderState(holder);
        if (state.optedIn && !state.frozen) {
            const frozen = await this.freezeHolder(holder);
            if (frozen)
                transactions.push(frozen.hash);
        }
        const { clawedBack, outcome } = await this.clawback(holder, 'all');
        if (outcome)
            transactions.push(outcome.hash);
        state = await this.getHolderState(holder);
        const problems = [];
        if (state.balance !== '0')
            problems.push(`balance is ${state.balance}`);
        if (state.lockedAmount !== '0')
            problems.push(`escrowed amount is ${state.lockedAmount}`);
        if (state.hasConfidentialBalance)
            problems.push('holds a confidential balance');
        if (state.authorized)
            problems.push('is still authorized');
        if (state.optedIn && !state.frozen)
            problems.push('is not frozen');
        if (problems.length > 0) {
            throw new ComplianceError('BAN_POSTCONDITION_FAILED', `Ban of ${holder} incomplete: ${problems.join(', ')}`);
        }
        this.deps.logger.warn('Holder banned', { holder, clawedBack, transactions });
        return { record, clawedBack, transactions };
    }
    // -------------------------------------------------------------- helpers
    async submit(tx) {
        await assertNetwork(this.deps);
        return submitAndRequireSuccess(this.deps.client, this.deps.issuerWallet, tx);
    }
    async readMPToken(holder) {
        return readValidatedEntry(this.deps.client, {
            mptoken: { mpt_issuance_id: this.issuanceId, account: holder },
        });
    }
    assertHolderAddress(holder) {
        if (!isValidClassicAddress(holder))
            throw new ComplianceError('INVALID_ADDRESS', `"${holder}" is not a classic address`);
        if (holder === this.issuerAddress)
            throw new ComplianceError('INVALID_ADDRESS', 'The issuer cannot be a holder');
    }
    async assertNotBanned(holder) {
        this.assertHolderAddress(holder);
        if (await this.deps.banRegistry.isBanned(holder)) {
            throw new ComplianceError('HOLDER_BANNED', `${holder} is banned`);
        }
    }
}
function assertSafeCapabilities(issuanceId, flags) {
    if ((flags & REQUIRED_CAPABILITIES) !== REQUIRED_CAPABILITIES) {
        throw new ComplianceError('ISSUANCE_MISCONFIGURED', `MPT issuance ${issuanceId} lacks Can Lock, Require Auth or Can Clawback (flags 0x${flags.toString(16)})`);
    }
    if ((flags & FORBIDDEN_CAPABILITIES) !== 0) {
        throw new ComplianceError('ISSUANCE_MISCONFIGURED', `MPT issuance ${issuanceId} enables escrow, trading or confidential balances, which a ban cannot claw back (flags 0x${flags.toString(16)})`);
    }
}
async function preflight(deps) {
    await assertNetwork(deps);
    await assertAmendmentsEnabled(deps.client, REQUIRED_AMENDMENTS);
}
async function assertNetwork(deps) {
    if (deps.expectedNetworkId === undefined)
        return;
    if (deps.client.networkID !== deps.expectedNetworkId) {
        throw new ComplianceError('WRONG_NETWORK', `Connected to network ${String(deps.client.networkID)}, expected ${deps.expectedNetworkId}`);
    }
}
//# sourceMappingURL=issuer.js.map