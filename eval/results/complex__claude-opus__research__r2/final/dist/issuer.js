import { MPTokenAuthorizeFlags, MPTokenIssuanceCreateFlags, MPTokenIssuanceSetFlags, convertStringToHex, decodeAccountID, encodeMPTokenMetadata, isValidClassicAddress, validateMPTokenMetadata, } from 'xrpl';
import { assertAssetScale, fromBaseUnits, parseLedgerAmount, toBaseUnits } from './amounts.js';
import { errorCode, submitAndConfirm } from './submit.js';
/** Flags on an MPTokenIssuance ledger entry. */
export const IssuanceFlags = {
    lsfMPTLocked: 0x01,
    lsfMPTCanLock: 0x02,
    lsfMPTRequireAuth: 0x04,
    lsfMPTCanEscrow: 0x08,
    lsfMPTCanTrade: 0x10,
    lsfMPTCanTransfer: 0x20,
    lsfMPTCanClawback: 0x40,
    lsfMPTCanHoldConfidentialBalance: 0x80,
};
/** Flags on a holder's MPToken ledger entry. */
export const HolderFlags = {
    lsfMPTLocked: 0x01,
    lsfMPTAuthorized: 0x02,
};
/** Every issuance managed by this module must have all of these set. */
const REQUIRED_ISSUANCE_FLAGS = IssuanceFlags.lsfMPTCanLock | IssuanceFlags.lsfMPTRequireAuth | IssuanceFlags.lsfMPTCanClawback;
/**
 * Capabilities that would let tokens leave the issuer's direct control:
 *  - Escrow: tokens in escrow (LockedAmount) can't be clawed back, so a
 *    holder could escrow funds just before a ban.
 *  - Trade: DEX/AMM positions need separate clawback handling.
 *  - Confidential balances: amounts are hidden from the issuer's view.
 */
const FORBIDDEN_ISSUANCE_FLAGS = IssuanceFlags.lsfMPTCanEscrow | IssuanceFlags.lsfMPTCanTrade | IssuanceFlags.lsfMPTCanHoldConfidentialBalance;
export class ComplianceError extends Error {
    name = 'ComplianceError';
}
/**
 * Issuer-side controls for a regulated MPT.
 *
 * The issuance always has Require Auth (allowlist), Can Lock (per-holder and
 * global freeze) and Can Clawback set. Escrow, DEX trading and confidential
 * balances are always off, because each would let tokens move out of reach of
 * clawback. Since DynamicMPT is not enabled on the network, these flags cannot
 * be changed after creation.
 *
 * Transactions from one instance run one at a time, so account sequence
 * numbers never collide. Run at most one instance per issuing account.
 *
 * Every read uses the latest validated ledger. The pre-flight checks give
 * clear errors without spending a fee. The ledger still enforces every rule
 * on its own, so a check that goes stale only means the transaction fails.
 */
export class MptIssuer {
    options;
    issuanceId;
    assetScale;
    queue = Promise.resolve();
    constructor(options, issuanceId, assetScale) {
        this.options = options;
        this.issuanceId = issuanceId;
        this.assetScale = assetScale;
    }
    get issuerAddress() {
        return this.options.wallet.classicAddress;
    }
    /** Create a new issuance with all compliance controls enabled. */
    static async create(options, config, context = {}) {
        assertAssetScale(config.assetScale);
        const metadataHex = encodeMPTokenMetadata(config.metadata);
        const metadataProblems = validateMPTokenMetadata(metadataHex);
        if (metadataProblems.length > 0) {
            throw new ComplianceError(`Token metadata does not follow XLS-89: ${metadataProblems.join('; ')}`);
        }
        if (config.transferFee !== undefined) {
            if (!Number.isInteger(config.transferFee) || config.transferFee < 0 || config.transferFee > 50_000) {
                throw new ComplianceError('transferFee must be an integer in [0, 50000]');
            }
            if (config.transferFee > 0 && !config.transferable) {
                throw new ComplianceError('A transfer fee requires a transferable token');
            }
        }
        let flags = MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
            MPTokenIssuanceCreateFlags.tfMPTCanLock |
            MPTokenIssuanceCreateFlags.tfMPTCanClawback;
        if (config.transferable) {
            flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer;
        }
        const tx = {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: options.wallet.classicAddress,
            AssetScale: config.assetScale,
            Flags: flags,
            MPTokenMetadata: metadataHex,
        };
        if (config.maximumAmount !== undefined) {
            tx.MaximumAmount = toBaseUnits(config.maximumAmount, config.assetScale).toString();
        }
        if (config.transferFee !== undefined && config.transferFee > 0) {
            tx.TransferFee = config.transferFee;
        }
        addMemo(tx, 'create-issuance', context);
        const result = await submitAndConfirm(options.client, options.wallet, tx);
        const issuanceId = extractIssuanceId(result, options.wallet.classicAddress);
        const issuer = await MptIssuer.attach(options, issuanceId);
        issuer.audit({ action: 'create-issuance', ...referenceOf(context) }, result);
        return issuer;
    }
    /**
     * Manage an existing issuance. Refuses issuances that aren't owned by the
     * wallet, or whose flags don't provide every compliance control.
     */
    static async attach(options, issuanceId) {
        if (!/^[0-9A-F]{48}$/i.test(issuanceId)) {
            throw new ComplianceError(`Not a valid MPT issuance ID: ${issuanceId}`);
        }
        const entry = await fetchIssuance(options.client, issuanceId);
        if (entry === undefined) {
            throw new ComplianceError(`MPT issuance ${issuanceId} does not exist in the validated ledger`);
        }
        if (entry.Issuer !== options.wallet.classicAddress) {
            throw new ComplianceError(`MPT issuance ${issuanceId} is issued by ${entry.Issuer}, not by this wallet`);
        }
        if ((entry.Flags & REQUIRED_ISSUANCE_FLAGS) !== REQUIRED_ISSUANCE_FLAGS) {
            throw new ComplianceError(`MPT issuance ${issuanceId} lacks Require Auth, Can Lock or Can Clawback (flags 0x${entry.Flags.toString(16)})`);
        }
        if ((entry.Flags & FORBIDDEN_ISSUANCE_FLAGS) !== 0) {
            throw new ComplianceError(`MPT issuance ${issuanceId} allows escrow, trading or confidential balances, which would let tokens escape clawback`);
        }
        return new MptIssuer(options, issuanceId.toUpperCase(), entry.AssetScale ?? 0);
    }
    // ---------------------------------------------------------------------------
    // Allowlist
    // ---------------------------------------------------------------------------
    /**
     * Put a holder on the allowlist after KYC. The holder must first opt in by
     * sending their own MPTokenAuthorize transaction; the ledger has nowhere to
     * record the authorization until then. Banned addresses are refused.
     */
    async authorizeHolder(holder, context = {}) {
        return this.serialize(async () => {
            this.assertHolderAddress(holder);
            if (await this.options.banRegistry.isBanned(holder)) {
                throw new ComplianceError(`${holder} is banned and cannot be authorized`);
            }
            const token = await this.fetchHolderToken(holder);
            if (token === undefined) {
                throw new ComplianceError(`${holder} has not opted in to this token yet (no MPToken entry)`);
            }
            if (hasFlag(token.Flags, HolderFlags.lsfMPTAuthorized)) {
                return undefined;
            }
            const tx = {
                TransactionType: 'MPTokenAuthorize',
                Account: this.issuerAddress,
                MPTokenIssuanceID: this.issuanceId,
                Holder: holder,
            };
            return this.submit(tx, { action: 'authorize-holder', holder, ...referenceOf(context) });
        });
    }
    /**
     * Remove a holder from the allowlist without banning them. They can no longer
     * receive the token. Any balance they hold stays put until you claw it back.
     */
    async revokeHolder(holder, context = {}) {
        return this.serialize(() => this.revokeUnlocked(holder, context));
    }
    // ---------------------------------------------------------------------------
    // Issuing and clawback
    // ---------------------------------------------------------------------------
    /** Mint `amount` (display units) to an approved holder. */
    async issue(holder, amount, context = {}) {
        return this.serialize(async () => {
            this.assertHolderAddress(holder);
            const units = toBaseUnits(amount, this.assetScale);
            if (await this.options.banRegistry.isBanned(holder)) {
                throw new ComplianceError(`${holder} is banned and cannot receive the token`);
            }
            const [issuance, token] = await Promise.all([this.fetchIssuanceEntry(), this.fetchHolderToken(holder)]);
            if (hasFlag(issuance.Flags, IssuanceFlags.lsfMPTLocked)) {
                throw new ComplianceError('The token is globally frozen');
            }
            if (token === undefined || !hasFlag(token.Flags, HolderFlags.lsfMPTAuthorized)) {
                throw new ComplianceError(`${holder} is not on the allowlist`);
            }
            if (hasFlag(token.Flags, HolderFlags.lsfMPTLocked)) {
                throw new ComplianceError(`${holder} is frozen`);
            }
            const tx = {
                TransactionType: 'Payment',
                Account: this.issuerAddress,
                Destination: holder,
                Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
            };
            const result = await this.submit(tx, { action: 'issue', holder, amount, ...referenceOf(context) });
            // A partial payment can't happen here (no tfPartialPayment flag), but
            // verify the delivered amount rather than trusting that.
            const delivered = result.meta.delivered_amount;
            if (typeof delivered !== 'object' || !('mpt_issuance_id' in delivered) || delivered.value !== units.toString()) {
                throw new Error(`Payment ${result.hash} delivered ${JSON.stringify(delivered)}, expected ${units} units`);
            }
            return result;
        });
    }
    /**
     * Claw back up to `amount` (display units) from a holder. If the holder has
     * less, the ledger claws back their entire balance. Works whether or not the
     * holder is frozen or authorized. Returns the amount actually recovered.
     */
    async clawback(holder, amount, context = {}) {
        return this.serialize(() => this.clawbackUnlocked(holder, toBaseUnits(amount, this.assetScale), context));
    }
    // ---------------------------------------------------------------------------
    // Freezes
    // ---------------------------------------------------------------------------
    /**
     * Freeze one holder so they can neither send nor receive the token.
     *
     * The ledger blocks every holder-to-holder payment to or from a frozen
     * holder (tecLOCKED). Payments between the holder and the issuer are
     * deliberately not blocked by the ledger, which leads to two cases:
     *  - issuer → frozen holder: the ledger allows it, so this module refuses
     *    to issue to a frozen holder. Don't bypass the module to pay one.
     *  - frozen holder → issuer (redemption/burn): allowed; tokens only leave
     *    circulation this way.
     * Clawback still works on a frozen holder.
     */
    async freezeHolder(holder, context = {}) {
        return this.serialize(() => this.setHolderLock(holder, true, context));
    }
    async unfreezeHolder(holder, context = {}) {
        return this.serialize(() => this.setHolderLock(holder, false, context));
    }
    /**
     * Freeze all movement of the token: every holder-to-holder payment fails
     * with tecLOCKED. As with per-holder freezes, the ledger doesn't block
     * issuance, so this module refuses to issue while globally frozen.
     * Redemptions to the issuer and clawback remain possible. Per-holder
     * freezes are independent and survive a global unfreeze.
     */
    async freezeAll(context = {}) {
        return this.serialize(() => this.setGlobalLock(true, context));
    }
    async unfreezeAll(context = {}) {
        return this.serialize(() => this.setGlobalLock(false, context));
    }
    // ---------------------------------------------------------------------------
    // Bans
    // ---------------------------------------------------------------------------
    /**
     * Ban an address permanently:
     *  1. record the ban in the registry, so the address can never be
     *     authorized again (this happens first, so a crash mid-way fails safe);
     *  2. freeze it, so it can't move its balance to other holders before the
     *     clawback lands;
     *  3. remove it from the allowlist. This is the lasting barrier: the lock
     *     is not, because while fixCleanup3_4_0 is off a zero-balance holder
     *     can delete a locked MPToken and opt in again. The new entry is
     *     unauthorized, so the address still can't receive anything;
     *  4. claw back its entire balance.
     *
     * Idempotent: calling it again finishes any steps that didn't complete.
     * Resolves only once the validated ledger shows a zero balance and no
     * authorization.
     */
    async ban(holder, context = {}) {
        return this.serialize(async () => {
            this.assertHolderAddress(holder);
            assertReference(context.reference);
            const actionContext = referenceOf(context);
            if (!(await this.options.banRegistry.isBanned(holder))) {
                await this.options.banRegistry.add({
                    address: holder,
                    bannedAt: new Date().toISOString(),
                    ...(context.reason === undefined ? {} : { reason: context.reason }),
                });
                this.options.onAudit?.({ action: 'ban', issuanceId: this.issuanceId, holder, ...actionContext });
            }
            const transactions = [];
            const token = await this.fetchHolderToken(holder);
            if (token !== undefined) {
                const locked = await this.setHolderLock(holder, true, actionContext);
                if (locked !== undefined)
                    transactions.push(locked);
                const revoked = await this.revokeUnlocked(holder, actionContext);
                if (revoked !== undefined)
                    transactions.push(revoked);
                const balance = parseLedgerAmount((await this.fetchHolderToken(holder))?.MPTAmount);
                if (balance > 0n) {
                    transactions.push((await this.clawbackUnlocked(holder, balance, actionContext)).tx);
                }
            }
            const state = await this.holderStateUnlocked(holder);
            if (state.balanceUnits !== 0n || state.authorized || !state.banned) {
                throw new Error(`Ban of ${holder} did not complete: ${JSON.stringify(stateForLog(state))}`);
            }
            return { state, transactions };
        });
    }
    // ---------------------------------------------------------------------------
    // Queries
    // ---------------------------------------------------------------------------
    async getHolder(holder) {
        this.assertHolderAddress(holder);
        return this.holderStateUnlocked(holder);
    }
    async getIssuance() {
        const entry = await this.fetchIssuanceEntry();
        const f = entry.Flags;
        return {
            issuanceId: this.issuanceId,
            issuer: entry.Issuer,
            assetScale: this.assetScale,
            globallyFrozen: hasFlag(f, IssuanceFlags.lsfMPTLocked),
            canLock: hasFlag(f, IssuanceFlags.lsfMPTCanLock),
            requireAuth: hasFlag(f, IssuanceFlags.lsfMPTRequireAuth),
            canClawback: hasFlag(f, IssuanceFlags.lsfMPTCanClawback),
            canTransfer: hasFlag(f, IssuanceFlags.lsfMPTCanTransfer),
            canEscrow: hasFlag(f, IssuanceFlags.lsfMPTCanEscrow),
            canTrade: hasFlag(f, IssuanceFlags.lsfMPTCanTrade),
            outstanding: fromBaseUnits(parseLedgerAmount(entry.OutstandingAmount), this.assetScale),
            maximumAmount: entry.MaximumAmount === undefined
                ? undefined
                : fromBaseUnits(parseLedgerAmount(entry.MaximumAmount), this.assetScale),
            flags: f,
        };
    }
    // ---------------------------------------------------------------------------
    // Internals. The *Unlocked methods assume the caller holds the queue.
    // ---------------------------------------------------------------------------
    async revokeUnlocked(holder, context) {
        this.assertHolderAddress(holder);
        const token = await this.fetchHolderToken(holder);
        if (token === undefined || !hasFlag(token.Flags, HolderFlags.lsfMPTAuthorized)) {
            return undefined;
        }
        const tx = {
            TransactionType: 'MPTokenAuthorize',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holder,
            Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
        };
        return this.submit(tx, { action: 'revoke-holder', holder, ...referenceOf(context) });
    }
    async clawbackUnlocked(holder, units, context) {
        this.assertHolderAddress(holder);
        const before = parseLedgerAmount((await this.fetchHolderToken(holder))?.MPTAmount);
        if (before === 0n) {
            throw new ComplianceError(`${holder} holds none of the token; nothing to claw back`);
        }
        const tx = {
            TransactionType: 'Clawback',
            Account: this.issuerAddress,
            Holder: holder,
            Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
        };
        const expected = units < before ? units : before;
        const result = await this.submit(tx, {
            action: 'clawback',
            holder,
            amount: fromBaseUnits(expected, this.assetScale),
            ...referenceOf(context),
        });
        const recovered = before - parseLedgerAmount(finalMPTAmount(result, holder, this.issuanceId));
        return { clawedBack: fromBaseUnits(recovered, this.assetScale), tx: result };
    }
    async setHolderLock(holder, lock, context) {
        this.assertHolderAddress(holder);
        const token = await this.fetchHolderToken(holder);
        if (token === undefined) {
            throw new ComplianceError(`${holder} has no MPToken entry for this token, so there is nothing to freeze`);
        }
        if (hasFlag(token.Flags, HolderFlags.lsfMPTLocked) === lock) {
            return undefined;
        }
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holder,
            Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
        };
        return this.submit(tx, { action: lock ? 'freeze-holder' : 'unfreeze-holder', holder, ...referenceOf(context) });
    }
    async setGlobalLock(lock, context) {
        const entry = await this.fetchIssuanceEntry();
        if (hasFlag(entry.Flags, IssuanceFlags.lsfMPTLocked) === lock) {
            return undefined;
        }
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Flags: lock ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
        };
        return this.submit(tx, { action: lock ? 'freeze-all' : 'unfreeze-all', ...referenceOf(context) });
    }
    async holderStateUnlocked(holder) {
        const [token, banned] = await Promise.all([
            this.fetchHolderToken(holder),
            this.options.banRegistry.isBanned(holder),
        ]);
        const units = parseLedgerAmount(token?.MPTAmount);
        return {
            address: holder,
            optedIn: token !== undefined,
            authorized: token !== undefined && hasFlag(token.Flags, HolderFlags.lsfMPTAuthorized),
            frozen: token !== undefined && hasFlag(token.Flags, HolderFlags.lsfMPTLocked),
            banned,
            balance: fromBaseUnits(units, this.assetScale),
            balanceUnits: units,
        };
    }
    async submit(tx, event) {
        addMemo(tx, event.action, event.reference === undefined ? {} : { reference: event.reference });
        const result = await submitAndConfirm(this.options.client, this.options.wallet, tx);
        this.audit(event, result);
        return result;
    }
    audit(event, result) {
        this.options.onAudit?.({ ...event, issuanceId: this.issuanceId, txHash: result.hash, ledgerIndex: result.ledgerIndex });
    }
    serialize(work) {
        const run = this.queue.then(work);
        this.queue = run.catch(() => undefined);
        return run;
    }
    assertHolderAddress(holder) {
        if (!isValidClassicAddress(holder)) {
            throw new ComplianceError(`Not a valid classic address: ${holder}`);
        }
        if (holder === this.issuerAddress) {
            throw new ComplianceError('The issuer cannot be a holder of its own token');
        }
    }
    async fetchIssuanceEntry() {
        const entry = await fetchIssuance(this.options.client, this.issuanceId);
        if (entry === undefined) {
            throw new Error(`MPT issuance ${this.issuanceId} no longer exists`);
        }
        return entry;
    }
    fetchHolderToken(holder) {
        return fetchLedgerEntry(this.options.client, {
            mptoken: { mpt_issuance_id: this.issuanceId, account: holder },
        });
    }
}
// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function hasFlag(flags, flag) {
    return (flags & flag) === flag;
}
function referenceOf(context) {
    return context.reference === undefined ? {} : { reference: context.reference };
}
function assertReference(reference) {
    if (reference !== undefined && !/^[\w.:/-]{1,128}$/.test(reference)) {
        throw new ComplianceError('reference must be 1–128 characters of letters, digits, "_", ".", ":", "/", "-" (it is published on-ledger)');
    }
}
const MEMO_TYPE = convertStringToHex('compliance');
/** Attach an on-ledger audit memo: the action, plus an optional opaque reference. */
function addMemo(tx, action, context) {
    assertReference(context.reference);
    const data = context.reference === undefined ? action : `${action} ${context.reference}`;
    const memo = { Memo: { MemoType: MEMO_TYPE, MemoData: convertStringToHex(data) } };
    tx.Memos = [memo];
}
async function fetchIssuance(client, issuanceId) {
    return fetchLedgerEntry(client, { mpt_issuance: issuanceId });
}
async function fetchLedgerEntry(client, selector) {
    try {
        const response = await client.request({ command: 'ledger_entry', ledger_index: 'validated', ...selector });
        return response.result.node;
    }
    catch (error) {
        if (errorCode(error) === 'entryNotFound') {
            return undefined;
        }
        throw error;
    }
}
/**
 * The MPT issuance ID is the 32-bit sequence of the creating transaction
 * followed by the issuer's 160-bit AccountID. Derive it independently and
 * check it against what the server reports.
 */
function extractIssuanceId(result, issuer) {
    const reported = result.meta.mpt_issuance_id;
    const txJson = result.response.result.tx_json;
    const sequence = txJson.TicketSequence ?? txJson.Sequence;
    if (sequence === undefined) {
        throw new Error(`MPTokenIssuanceCreate ${result.hash} has no Sequence`);
    }
    const derived = (sequence.toString(16).padStart(8, '0') + Buffer.from(decodeAccountID(issuer)).toString('hex')).toUpperCase();
    if (typeof reported === 'string' && reported.toUpperCase() !== derived) {
        throw new Error(`Server reported MPT issuance ID ${reported}, but it should be ${derived}`);
    }
    return derived;
}
/** Read a holder's MPTAmount after a transaction from its metadata. */
function finalMPTAmount(result, holder, issuanceId) {
    for (const node of result.meta.AffectedNodes) {
        const inner = 'ModifiedNode' in node ? node.ModifiedNode : 'DeletedNode' in node ? node.DeletedNode : undefined;
        if (inner?.LedgerEntryType !== 'MPToken')
            continue;
        const fields = inner.FinalFields;
        if (fields?.Account === holder && fields.MPTokenIssuanceID?.toUpperCase() === issuanceId) {
            return fields.MPTAmount ?? '0';
        }
    }
    throw new Error(`Transaction ${result.hash} did not modify ${holder}'s MPToken entry`);
}
function stateForLog(state) {
    return { ...state, balanceUnits: state.balanceUnits.toString() };
}
//# sourceMappingURL=issuer.js.map