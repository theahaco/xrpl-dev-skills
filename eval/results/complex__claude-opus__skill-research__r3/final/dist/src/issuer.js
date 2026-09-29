"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MptIssuer = void 0;
const xrpl_1 = require("xrpl");
const amount_js_1 = require("./amount.js");
const errors_js_1 = require("./errors.js");
/** MPTokenIssuance ledger flags (xrpl.org: MPTokenIssuance > Flags). */
const lsfMPTLocked = 0x01;
const lsfMPTCanLock = 0x02;
const lsfMPTRequireAuth = 0x04;
const lsfMPTCanEscrow = 0x08;
const lsfMPTCanTrade = 0x10;
const lsfMPTCanTransfer = 0x20;
const lsfMPTCanClawback = 0x40;
/** MPToken ledger flags (xrpl.org: MPToken > Flags). */
const lsfMPTokenLocked = 0x01;
const lsfMPTokenAuthorized = 0x02;
/** Flags every issuance managed by this module must have. */
const REQUIRED_ISSUANCE_FLAGS = lsfMPTCanLock | lsfMPTRequireAuth | lsfMPTCanClawback;
/**
 * Issuer-side compliance controls for one MPT issuance: allowlist, issuance,
 * clawback, bans, per-holder freeze and global freeze.
 *
 * Every mutating call checks the validated ledger state first and runs
 * exclusively (one at a time per instance), so a check can't be invalidated by
 * a concurrent call from the same process. Run a single instance per issuance;
 * across processes, use an external lock.
 */
class MptIssuer {
    deps;
    wallet;
    issuanceId;
    assetScale;
    exclusiveChain = Promise.resolve();
    constructor(deps, wallet, issuanceId, assetScale) {
        this.deps = deps;
        this.wallet = wallet;
        this.issuanceId = issuanceId;
        this.assetScale = assetScale;
    }
    /**
     * Creates a new issuance with allowlisting, locking and clawback enabled.
     * Escrow and DEX trading are deliberately not enabled: clawback can't reach
     * escrowed balances, and neither feature is needed for the controls here.
     */
    static async create(deps, wallet, config) {
        const metadataHex = (0, xrpl_1.encodeMPTokenMetadata)(config.metadata);
        const problems = (0, xrpl_1.validateMPTokenMetadata)(metadataHex);
        if (problems.length > 0) {
            throw new errors_js_1.ValidationError(`MPTokenMetadata is not XLS-89 compliant: ${problems.join('; ')}`);
        }
        if (!Number.isInteger(config.assetScale) || config.assetScale < 0 || config.assetScale > 19) {
            throw new errors_js_1.ValidationError('assetScale must be an integer between 0 and 19');
        }
        let flags = xrpl_1.MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
            xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanLock |
            xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanClawback;
        if (config.allowHolderTransfers ?? true)
            flags |= xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanTransfer;
        const outcome = await deps.submitter.submit(wallet, {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: wallet.classicAddress,
            AssetScale: config.assetScale,
            Flags: flags,
            MPTokenMetadata: metadataHex,
            ...(config.maximumAmount !== undefined && {
                MaximumAmount: (0, amount_js_1.toBaseUnits)(config.maximumAmount, config.assetScale).toString(),
            }),
        });
        const issuanceId = outcome.meta.mpt_issuance_id;
        if (!issuanceId)
            throw new errors_js_1.LedgerStateError(`MPTokenIssuanceCreate ${outcome.hash} returned no mpt_issuance_id`);
        const issuer = new MptIssuer(deps, wallet, issuanceId, config.assetScale);
        issuer.audit({ action: 'create_issuance', txHash: outcome.hash, detail: `flags=${flags}` });
        return issuer;
    }
    /** Attaches to an existing issuance after checking that `wallet` issued it and that all controls are enabled. */
    static async load(deps, wallet, issuanceId) {
        const issuance = await readIssuance(deps.client, issuanceId);
        if (issuance.Issuer !== wallet.classicAddress) {
            throw new errors_js_1.LedgerStateError(`Issuance ${issuanceId} is issued by ${issuance.Issuer}, not ${wallet.classicAddress}`);
        }
        if ((issuance.Flags & REQUIRED_ISSUANCE_FLAGS) !== REQUIRED_ISSUANCE_FLAGS) {
            throw new errors_js_1.LedgerStateError(`Issuance ${issuanceId} lacks RequireAuth, CanLock or CanClawback`);
        }
        return new MptIssuer(deps, wallet, issuanceId, issuance.AssetScale ?? 0);
    }
    get issuerAddress() {
        return this.wallet.classicAddress;
    }
    async getIssuanceState() {
        const issuance = await readIssuance(this.deps.client, this.issuanceId);
        const has = (flag) => (issuance.Flags & flag) !== 0;
        return {
            issuanceId: this.issuanceId,
            issuer: issuance.Issuer,
            assetScale: this.assetScale,
            outstanding: (0, amount_js_1.fromBaseUnits)(BigInt(issuance.OutstandingAmount ?? '0'), this.assetScale),
            maximumAmount: issuance.MaximumAmount === undefined
                ? undefined
                : (0, amount_js_1.fromBaseUnits)(BigInt(issuance.MaximumAmount), this.assetScale),
            globallyFrozen: has(lsfMPTLocked),
            capabilities: {
                requireAuth: has(lsfMPTRequireAuth),
                canLock: has(lsfMPTCanLock),
                canClawback: has(lsfMPTCanClawback),
                canTransfer: has(lsfMPTCanTransfer),
                canEscrow: has(lsfMPTCanEscrow),
                canTrade: has(lsfMPTCanTrade),
            },
        };
    }
    async getHolderState(address) {
        this.assertHolderAddress(address);
        const [token, banned] = await Promise.all([
            readMPToken(this.deps.client, this.issuanceId, address),
            this.deps.banRegistry.isBanned(this.issuanceId, address),
        ]);
        const balanceBaseUnits = BigInt(token?.MPTAmount ?? '0');
        return {
            address,
            optedIn: token !== undefined,
            approved: token !== undefined && (token.Flags & lsfMPTokenAuthorized) !== 0,
            frozen: token !== undefined && (token.Flags & lsfMPTokenLocked) !== 0,
            banned,
            balance: (0, amount_js_1.fromBaseUnits)(balanceBaseUnits, this.assetScale),
            balanceBaseUnits,
        };
    }
    /** Adds a KYC-approved holder to the allowlist. The holder must have opted in first. */
    async approveHolder(address, reason) {
        return this.exclusive(async () => {
            const holder = await this.getHolderState(address);
            if (holder.banned)
                throw new errors_js_1.ComplianceViolationError(`${address} is banned and cannot be approved`);
            if (!holder.optedIn) {
                throw new errors_js_1.LedgerStateError(`${address} has not opted in to ${this.issuanceId} (no MPToken entry)`);
            }
            if (holder.approved)
                return { changed: false };
            const tx = await this.submit({
                TransactionType: 'MPTokenAuthorize',
                Account: this.issuerAddress,
                MPTokenIssuanceID: this.issuanceId,
                Holder: address,
            });
            this.audit({ action: 'approve', holder: address, txHash: tx.hash, reason });
            return { changed: true, txHash: tx.hash };
        });
    }
    /**
     * Removes a holder from the allowlist. They keep any balance but can neither
     * send nor receive the token until re-approved. Use `ban` to also remove the balance.
     */
    async revokeApproval(address, reason) {
        return this.exclusive(async () => {
            const holder = await this.getHolderState(address);
            if (!holder.approved)
                return { changed: false };
            const hash = await this.unauthorize(address);
            this.audit({ action: 'revoke_approval', holder: address, txHash: hash, reason });
            return { changed: true, txHash: hash };
        });
    }
    /**
     * Issues (mints) `amount` tokens to an approved holder. Refuses to issue to
     * holders that are banned, not approved or frozen, and while the token is
     * globally frozen. The ledger itself lets an issuer pay a frozen holder, so
     * this check is what keeps frozen holders from receiving.
     */
    async issue(address, amount, reason) {
        const units = (0, amount_js_1.toBaseUnits)(amount, this.assetScale);
        return this.exclusive(async () => {
            const [holder, issuance] = await Promise.all([this.getHolderState(address), this.getIssuanceState()]);
            if (holder.banned)
                throw new errors_js_1.ComplianceViolationError(`${address} is banned`);
            if (!holder.approved)
                throw new errors_js_1.ComplianceViolationError(`${address} is not an approved holder`);
            if (holder.frozen)
                throw new errors_js_1.ComplianceViolationError(`${address} is frozen`);
            if (issuance.globallyFrozen)
                throw new errors_js_1.ComplianceViolationError('The token is globally frozen');
            const tx = await this.submit({
                TransactionType: 'Payment',
                Account: this.issuerAddress,
                Destination: address,
                Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
            });
            this.audit({ action: 'issue', holder: address, amount: (0, amount_js_1.fromBaseUnits)(units, this.assetScale), txHash: tx.hash, reason });
            return { changed: true, txHash: tx.hash };
        });
    }
    /**
     * Claws back `amount` tokens (or the whole balance with "all") from any
     * holder, whether or not they are frozen or approved. If `amount` is more
     * than the balance, the whole balance is clawed back. The result reports the
     * amount actually removed, read from the transaction metadata.
     */
    async clawback(address, amount, reason) {
        const requested = amount === 'all' ? amount_js_1.MAX_MPT_AMOUNT : (0, amount_js_1.toBaseUnits)(amount, this.assetScale);
        return this.exclusive(async () => {
            const holder = await this.getHolderState(address);
            if (holder.balanceBaseUnits === 0n) {
                if (amount === 'all')
                    return { changed: false, clawedBack: '0' };
                throw new errors_js_1.LedgerStateError(`${address} holds none of the token`);
            }
            const { hash, clawedBack } = await this.clawbackUnits(address, requested);
            this.audit({ action: 'clawback', holder: address, amount: clawedBack, txHash: hash, reason });
            return { changed: true, txHash: hash, clawedBack };
        });
    }
    /** Freezes one holder: they can no longer send to or receive from other holders. */
    async freezeHolder(address, reason) {
        return this.exclusive(async () => {
            const holder = await this.requireOptedIn(address);
            if (holder.frozen)
                return { changed: false };
            const hash = await this.setHolderLock(address, true);
            this.audit({ action: 'freeze_holder', holder: address, txHash: hash, reason });
            return { changed: true, txHash: hash };
        });
    }
    async unfreezeHolder(address, reason) {
        return this.exclusive(async () => {
            const holder = await this.requireOptedIn(address);
            if (holder.banned)
                throw new errors_js_1.ComplianceViolationError(`${address} is banned and stays frozen`);
            if (!holder.frozen)
                return { changed: false };
            const hash = await this.setHolderLock(address, false);
            this.audit({ action: 'unfreeze_holder', holder: address, txHash: hash, reason });
            return { changed: true, txHash: hash };
        });
    }
    /** Freezes all transfers between holders. Issuance also stops (enforced by this module). */
    async freezeAll(reason) {
        return this.exclusive(async () => {
            if ((await this.getIssuanceState()).globallyFrozen)
                return { changed: false };
            const tx = await this.submit({
                TransactionType: 'MPTokenIssuanceSet',
                Account: this.issuerAddress,
                MPTokenIssuanceID: this.issuanceId,
                Flags: xrpl_1.MPTokenIssuanceSetFlags.tfMPTLock,
            });
            this.audit({ action: 'freeze_all', txHash: tx.hash, reason });
            return { changed: true, txHash: tx.hash };
        });
    }
    async unfreezeAll(reason) {
        return this.exclusive(async () => {
            if (!(await this.getIssuanceState()).globallyFrozen)
                return { changed: false };
            const tx = await this.submit({
                TransactionType: 'MPTokenIssuanceSet',
                Account: this.issuerAddress,
                MPTokenIssuanceID: this.issuanceId,
                Flags: xrpl_1.MPTokenIssuanceSetFlags.tfMPTUnlock,
            });
            this.audit({ action: 'unfreeze_all', txHash: tx.hash, reason });
            return { changed: true, txHash: tx.hash };
        });
    }
    /**
     * Bans an address permanently. The steps:
     *   1. Record the ban durably, so the address can never be re-approved.
     *   2. Freeze the holder, so nothing moves while the ban is carried out.
     *   3. Remove them from the allowlist. The ledger then rejects any payment to them.
     *   4. Claw back their entire balance.
     *   5. Re-read the validated ledger to confirm: zero balance, not approved.
     * Safe to call again; completed steps are skipped, so a ban interrupted
     * partway through can be finished by calling this again.
     */
    async ban(address, reason) {
        if (!reason.trim())
            throw new errors_js_1.ValidationError('A ban requires a reason');
        this.assertHolderAddress(address);
        return this.exclusive(async () => {
            const record = (await this.deps.banRegistry.get(this.issuanceId, address)) ?? {
                issuanceId: this.issuanceId,
                address,
                reason,
                bannedAt: new Date().toISOString(),
            };
            await this.deps.banRegistry.record(record);
            const txHashes = [];
            let clawedBack = '0';
            const holder = await this.getHolderState(address);
            if (holder.optedIn) {
                if (!holder.frozen)
                    txHashes.push(await this.setHolderLock(address, true));
                if (holder.approved)
                    txHashes.push(await this.unauthorize(address));
                if (holder.balanceBaseUnits > 0n) {
                    const result = await this.clawbackUnits(address, amount_js_1.MAX_MPT_AMOUNT);
                    txHashes.push(result.hash);
                    clawedBack = result.clawedBack;
                }
            }
            const after = await this.getHolderState(address);
            if (after.balanceBaseUnits !== 0n || after.approved) {
                throw new errors_js_1.LedgerStateError(`Ban of ${address} did not complete: balance=${after.balance}, approved=${after.approved}`);
            }
            this.audit({ action: 'ban', holder: address, amount: clawedBack, txHash: txHashes.at(-1), reason, detail: txHashes.join(',') });
            return { address, txHashes, clawedBack, record };
        });
    }
    // --- internals -----------------------------------------------------------
    async requireOptedIn(address) {
        const holder = await this.getHolderState(address);
        if (!holder.optedIn)
            throw new errors_js_1.LedgerStateError(`${address} holds no MPToken entry for ${this.issuanceId}`);
        return holder;
    }
    async setHolderLock(address, lock) {
        const tx = await this.submit({
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Holder: address,
            Flags: lock ? xrpl_1.MPTokenIssuanceSetFlags.tfMPTLock : xrpl_1.MPTokenIssuanceSetFlags.tfMPTUnlock,
        });
        return tx.hash;
    }
    async unauthorize(address) {
        const tx = await this.submit({
            TransactionType: 'MPTokenAuthorize',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Holder: address,
            Flags: xrpl_1.MPTokenAuthorizeFlags.tfMPTUnauthorize,
        });
        return tx.hash;
    }
    async clawbackUnits(address, units) {
        const tx = await this.submit({
            TransactionType: 'Clawback',
            Account: this.issuerAddress,
            Holder: address,
            Amount: { mpt_issuance_id: this.issuanceId, value: units.toString() },
        });
        return { hash: tx.hash, clawedBack: (0, amount_js_1.fromBaseUnits)(mptBalanceDecrease(tx.meta, address), this.assetScale) };
    }
    async submit(tx) {
        return this.deps.submitter.submit(this.wallet, tx);
    }
    async exclusive(task) {
        const run = this.exclusiveChain.catch(() => undefined).then(task);
        this.exclusiveChain = run;
        return run;
    }
    assertHolderAddress(address) {
        if (!(0, xrpl_1.isValidClassicAddress)(address))
            throw new errors_js_1.ValidationError(`Invalid classic address: ${address}`);
        if (address === this.issuerAddress)
            throw new errors_js_1.ValidationError('The issuer cannot be a holder of its own token');
    }
    audit(event) {
        this.deps.onAudit?.({ at: new Date().toISOString(), issuanceId: this.issuanceId, ...event });
    }
}
exports.MptIssuer = MptIssuer;
async function readIssuance(client, issuanceId) {
    const entry = await readLedgerEntry(client, { mpt_issuance: issuanceId });
    if (!entry)
        throw new errors_js_1.LedgerStateError(`MPT issuance ${issuanceId} not found in the validated ledger`);
    return entry;
}
async function readMPToken(client, issuanceId, account) {
    const entry = await readLedgerEntry(client, { mptoken: { mpt_issuance_id: issuanceId, account } });
    return entry;
}
async function readLedgerEntry(client, selector) {
    try {
        const response = await client.request({ command: 'ledger_entry', ledger_index: 'validated', ...selector });
        return response.result.node;
    }
    catch (error) {
        if (error.data?.error === 'entryNotFound')
            return undefined;
        throw error;
    }
}
/** Reads how far `holder`'s MPToken balance went down in a transaction, from its metadata. */
function mptBalanceDecrease(meta, holder) {
    for (const node of meta.AffectedNodes) {
        const modified = 'ModifiedNode' in node ? node.ModifiedNode : undefined;
        if (modified?.LedgerEntryType !== 'MPToken' || modified.FinalFields?.['Account'] !== holder)
            continue;
        // MPTAmount is omitted from the ledger entry when it is zero, and from
        // PreviousFields when it did not change.
        const finalAmount = modified.FinalFields['MPTAmount'] ?? '0';
        const before = BigInt(modified.PreviousFields?.['MPTAmount'] ?? finalAmount);
        const after = BigInt(finalAmount);
        return before - after;
    }
    throw new errors_js_1.LedgerStateError(`Transaction metadata has no MPToken change for ${holder}`);
}
//# sourceMappingURL=issuer.js.map