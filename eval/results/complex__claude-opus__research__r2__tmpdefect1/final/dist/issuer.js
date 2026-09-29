import { LedgerEntry, MPTokenAuthorizeFlags, MPTokenIssuanceCreateFlags, MPTokenIssuanceSetFlags, encodeMPTokenMetadata, isValidClassicAddress, } from 'xrpl';
import { MAX_MPT_AMOUNT, fromBaseUnits, parseLedgerAmount, toBaseUnits } from './amount.js';
import { InvalidInputError, IssuanceConfigurationError, PolicyViolationError, PostConditionError, } from './errors.js';
import { MPTokenFlags, getIssuanceEntry, getMPTokenEntry, submitOrThrow, } from './ledger.js';
const { MPTokenIssuanceFlags } = LedgerEntry;
/** Issuance capabilities the compliance controls depend on. */
export const REQUIRED_ISSUANCE_FLAGS = MPTokenIssuanceFlags.lsfMPTRequireAuth | MPTokenIssuanceFlags.lsfMPTCanLock | MPTokenIssuanceFlags.lsfMPTCanClawback;
/**
 * Capabilities this module refuses to work with, because each one lets value sit
 * where the standard Clawback transaction can't reach it or where the allowlist
 * doesn't apply. With any of them, a ban could no longer guarantee a zero balance.
 *  - CanEscrow: escrowed balances (LockedAmount) can't be clawed back.
 *  - CanHoldConfidentialBalance: encrypted balances need ConfidentialMPTClawback.
 *  - CanTrade: DEX/AMM positions live in offers or pseudo-accounts.
 */
export const FORBIDDEN_ISSUANCE_FLAGS = MPTokenIssuanceFlags.lsfMPTCanEscrow |
    MPTokenIssuanceFlags.lsfMPTCanTrade |
    MPTokenIssuanceFlags.lsfMPTCanHoldConfidentialBalance;
/**
 * Issuer-side compliance controls for one MPT issuance.
 *
 * All ledger-changing methods are serialized per instance, so concurrent calls from
 * your backend can't collide on account Sequence numbers. Run at most one instance
 * per issuer account; for more, use Tickets or an external lock.
 */
export class MptIssuer {
    issuanceId;
    assetScale;
    #client;
    #wallet;
    #bans;
    #networkId;
    #onAudit;
    #queue = Promise.resolve();
    constructor(options, issuance, issuanceId) {
        this.#client = options.client;
        this.#wallet = options.wallet;
        this.#bans = options.banRegistry;
        this.#networkId = options.expectedNetworkId;
        this.#onAudit = options.onAudit;
        this.issuanceId = issuanceId;
        this.assetScale = issuance.AssetScale ?? 0;
    }
    /** Creates a new issuance with every compliance control enabled and returns an issuer for it. */
    static async createIssuance(options, params) {
        const allowTransfers = params.allowHolderTransfers ?? true;
        if (params.transferFee !== undefined) {
            if (!Number.isInteger(params.transferFee) || params.transferFee < 0 || params.transferFee > 50_000) {
                throw new InvalidInputError('transferFee must be an integer between 0 and 50000');
            }
            if (params.transferFee > 0 && !allowTransfers) {
                throw new InvalidInputError('A transfer fee requires allowHolderTransfers');
            }
        }
        const maximum = params.maximumAmount === undefined ? undefined : toBaseUnits(params.maximumAmount, params.assetScale);
        if (maximum === 0n)
            throw new InvalidInputError('maximumAmount must be positive');
        let flags = MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
            MPTokenIssuanceCreateFlags.tfMPTCanLock |
            MPTokenIssuanceCreateFlags.tfMPTCanClawback;
        if (allowTransfers)
            flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer;
        const tx = {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: options.wallet.classicAddress,
            AssetScale: params.assetScale,
            Flags: flags,
            ...(maximum !== undefined && { MaximumAmount: maximum.toString() }),
            ...(params.transferFee && { TransferFee: params.transferFee }),
            ...(params.metadata && { MPTokenMetadata: encodeMPTokenMetadata(params.metadata) }),
        };
        const result = await submitOrThrow(options.client, options.wallet, tx, options.expectedNetworkId);
        const issuanceId = result.meta.mpt_issuance_id;
        if (!issuanceId)
            throw new PostConditionError(`No mpt_issuance_id in metadata of ${result.hash}`);
        const issuer = await MptIssuer.open(options, issuanceId);
        issuer.#audit({ action: 'create-issuance', txHash: result.hash, ledgerIndex: result.ledgerIndex });
        return issuer;
    }
    /** Attaches to an existing issuance after checking that the controls are available. */
    static async open(options, issuanceId) {
        if (!/^[0-9A-F]{48}$/i.test(issuanceId))
            throw new InvalidInputError(`Invalid MPT issuance ID ${issuanceId}`);
        const issuance = await getIssuanceEntry(options.client, issuanceId);
        if (!issuance)
            throw new IssuanceConfigurationError(`Issuance ${issuanceId} not found in the validated ledger`);
        if (issuance.Issuer !== options.wallet.classicAddress) {
            throw new IssuanceConfigurationError(`Issuance ${issuanceId} belongs to ${issuance.Issuer}, not ${options.wallet.classicAddress}`);
        }
        if ((issuance.Flags & REQUIRED_ISSUANCE_FLAGS) !== REQUIRED_ISSUANCE_FLAGS) {
            throw new IssuanceConfigurationError(`Issuance ${issuanceId} lacks RequireAuth, CanLock or CanClawback (flags 0x${issuance.Flags.toString(16)})`);
        }
        if ((issuance.Flags & FORBIDDEN_ISSUANCE_FLAGS) !== 0) {
            throw new IssuanceConfigurationError(`Issuance ${issuanceId} enables escrow, DEX trading or confidential balances, which would let a banned holder keep value`);
        }
        if (issuance.DomainID) {
            throw new IssuanceConfigurationError(`Issuance ${issuanceId} uses a permissioned domain, which authorizes holders without the issuer's allowlist`);
        }
        return new MptIssuer(options, issuance, issuanceId.toUpperCase());
    }
    // ---------------------------------------------------------------- allowlist
    /**
     * Adds a KYC-approved holder to the allowlist. The holder must first opt in by
     * submitting their own MPTokenAuthorize transaction.
     */
    async approveHolder(address) {
        return this.#exclusive(async () => {
            this.#assertHolderAddress(address);
            await this.#assertNotBanned(address, 'approve');
            const token = await this.#requireMPToken(address);
            if (token.Flags & MPTokenFlags.lsfMPTAuthorized)
                return noop('holder is already approved');
            const result = await this.#submit({
                TransactionType: 'MPTokenAuthorize',
                Account: this.#wallet.classicAddress,
                MPTokenIssuanceID: this.issuanceId,
                Holder: address,
            });
            this.#audit({ action: 'approve-holder', holder: address, ...txRef(result) });
            return submitted(result);
        });
    }
    /**
     * Removes a holder from the allowlist. They can no longer send or receive the
     * token, but keep their current balance. Use {@link ban} to also zero the balance
     * and block re-approval.
     */
    async revokeApproval(address) {
        return this.#exclusive(async () => this.#revokeApproval(address));
    }
    // ------------------------------------------------------------------ supply
    /** Sends newly issued tokens to an approved, unfrozen holder. */
    async issue(address, amount) {
        return this.#exclusive(async () => {
            this.#assertHolderAddress(address);
            const units = this.#positiveUnits(amount);
            await this.#assertNotBanned(address, 'issue to');
            const token = await this.#requireMPToken(address);
            if (!(token.Flags & MPTokenFlags.lsfMPTAuthorized)) {
                throw new PolicyViolationError(`${address} is not approved to hold ${this.issuanceId}`);
            }
            // The ledger lets the issuer pay a locked holder. This module doesn't, so a freeze
            // also stops the holder from receiving.
            if (token.Flags & MPTokenFlags.lsfMPTLocked)
                throw new PolicyViolationError(`${address} is frozen`);
            const issuance = await this.#issuance();
            if (issuance.Flags & MPTokenIssuanceFlags.lsfMPTLocked) {
                throw new PolicyViolationError('The token is globally frozen');
            }
            const outstanding = parseLedgerAmount(issuance.OutstandingAmount);
            const maximum = issuance.MaximumAmount === undefined ? MAX_MPT_AMOUNT : parseLedgerAmount(issuance.MaximumAmount);
            if (outstanding + units > maximum) {
                throw new PolicyViolationError(`Issuing ${amount} would exceed the maximum supply`);
            }
            const result = await this.#submit({
                TransactionType: 'Payment',
                Account: this.#wallet.classicAddress,
                Destination: address,
                Amount: this.#mptAmount(units),
            });
            const delivered = result.meta.delivered_amount;
            if (!delivered || delivered.mpt_issuance_id !== this.issuanceId || BigInt(delivered.value) !== units) {
                throw new PostConditionError(`Payment ${result.hash} delivered ${JSON.stringify(delivered)}, expected ${units}`);
            }
            this.#audit({ action: 'issue', holder: address, amount, ...txRef(result) });
            return submitted(result);
        });
    }
    // ---------------------------------------------------------------- clawback
    /**
     * Claws back exactly `amount` from a holder. Fails if the holder's balance is
     * smaller; use {@link clawbackAll} to take whatever they hold.
     */
    async clawback(address, amount) {
        return this.#exclusive(async () => {
            this.#assertHolderAddress(address);
            const units = this.#positiveUnits(amount);
            const balance = parseLedgerAmount((await this.#requireMPToken(address)).MPTAmount);
            if (units > balance) {
                throw new PolicyViolationError(`${address} holds ${fromBaseUnits(balance, this.assetScale)}, less than the requested ${amount}`);
            }
            return this.#clawback(address, units, 'clawback');
        });
    }
    /** Claws back a holder's entire balance in one transaction, even if it changes in flight. */
    async clawbackAll(address) {
        return this.#exclusive(async () => {
            this.#assertHolderAddress(address);
            return this.#clawbackAll(address);
        });
    }
    // ------------------------------------------------------------------ freeze
    /**
     * Freezes one holder. On the ledger, a frozen holder can't send to or receive from
     * other holders. This module also refuses to issue to them. The ledger still lets a
     * frozen holder send tokens back to the issuer (redemption), and the issuer can
     * always claw back.
     */
    async freezeHolder(address) {
        return this.#exclusive(async () => {
            this.#assertHolderAddress(address);
            return this.#freezeHolder(address);
        });
    }
    async unfreezeHolder(address) {
        return this.#exclusive(async () => {
            this.#assertHolderAddress(address);
            await this.#assertNotBanned(address, 'unfreeze');
            const token = await this.#requireMPToken(address);
            if (!(token.Flags & MPTokenFlags.lsfMPTLocked))
                return noop('holder is not frozen');
            const result = await this.#submit(this.#lockTx(MPTokenIssuanceSetFlags.tfMPTUnlock, address));
            this.#audit({ action: 'unfreeze-holder', holder: address, ...txRef(result) });
            return submitted(result);
        });
    }
    /** Freezes all transfers between holders, and all issuance through this module. */
    async freezeAll() {
        return this.#exclusive(async () => {
            if ((await this.#issuance()).Flags & MPTokenIssuanceFlags.lsfMPTLocked)
                return noop('already globally frozen');
            const result = await this.#submit(this.#lockTx(MPTokenIssuanceSetFlags.tfMPTLock));
            this.#audit({ action: 'global-freeze', ...txRef(result) });
            return submitted(result);
        });
    }
    async unfreezeAll() {
        return this.#exclusive(async () => {
            if (!((await this.#issuance()).Flags & MPTokenIssuanceFlags.lsfMPTLocked))
                return noop('not globally frozen');
            const result = await this.#submit(this.#lockTx(MPTokenIssuanceSetFlags.tfMPTUnlock));
            this.#audit({ action: 'global-unfreeze', ...txRef(result) });
            return submitted(result);
        });
    }
    // --------------------------------------------------------------------- ban
    /**
     * Bans an address permanently.
     *
     * 1. Records the ban durably, so {@link approveHolder} refuses the address from now on.
     * 2. Freezes the holder, so they can't send to or receive from other holders.
     * 3. Revokes approval, so the ledger itself rejects any payment to or from them.
     * 4. Claws back the full balance.
     * 5. Re-reads the ledger and checks the holder has zero balance and no approval.
     *
     * Idempotent: a partly completed ban can be finished by calling it again.
     */
    async ban(address, reason) {
        return this.#exclusive(async () => {
            this.#assertHolderAddress(address);
            if (!reason.trim())
                throw new InvalidInputError('A ban reason is required');
            await this.#bans.add({ address, reason, bannedAt: new Date().toISOString() });
            const record = (await this.#bans.get(address));
            this.#audit({ action: 'ban-recorded', holder: address, detail: reason });
            const steps = [];
            if (await getMPTokenEntry(this.#client, this.issuanceId, address)) {
                steps.push({ step: 'freeze', outcome: await this.#freezeHolder(address) });
                steps.push({ step: 'revoke-approval', outcome: await this.#revokeApproval(address) });
                const claw = await this.#clawbackAll(address);
                steps.push({ step: 'clawback', outcome: claw, ...(claw.clawedBack !== undefined && { amount: claw.clawedBack }) });
            }
            const finalStatus = await this.getHolderStatus(address);
            if (finalStatus.balanceBaseUnits !== 0n || finalStatus.approved) {
                throw new PostConditionError(`Ban of ${address} incomplete: ${JSON.stringify(serializable(finalStatus))}`);
            }
            this.#audit({ action: 'ban-completed', holder: address });
            return { address, record, steps, finalStatus };
        });
    }
    async isBanned(address) {
        return this.#bans.isBanned(address);
    }
    // ------------------------------------------------------------------- reads
    async getHolderStatus(address) {
        this.#assertHolderAddress(address);
        const [token, banned] = await Promise.all([
            getMPTokenEntry(this.#client, this.issuanceId, address),
            this.#bans.isBanned(address),
        ]);
        const balance = parseLedgerAmount(token?.MPTAmount);
        return {
            address,
            optedIn: token !== null,
            approved: token !== null && (token.Flags & MPTokenFlags.lsfMPTAuthorized) !== 0,
            frozen: token !== null && (token.Flags & MPTokenFlags.lsfMPTLocked) !== 0,
            banned,
            balance: fromBaseUnits(balance, this.assetScale),
            balanceBaseUnits: balance,
        };
    }
    async getIssuanceStatus() {
        const issuance = await this.#issuance();
        const maximum = issuance.MaximumAmount === undefined ? MAX_MPT_AMOUNT : parseLedgerAmount(issuance.MaximumAmount);
        return {
            issuanceId: this.issuanceId,
            issuer: issuance.Issuer,
            assetScale: this.assetScale,
            globallyFrozen: (issuance.Flags & MPTokenIssuanceFlags.lsfMPTLocked) !== 0,
            outstanding: fromBaseUnits(parseLedgerAmount(issuance.OutstandingAmount), this.assetScale),
            maximum: fromBaseUnits(maximum, this.assetScale),
            flags: issuance.Flags,
        };
    }
    // ----------------------------------------------------------------- private
    async #revokeApproval(address) {
        this.#assertHolderAddress(address);
        const token = await getMPTokenEntry(this.#client, this.issuanceId, address);
        if (!token)
            return noop('holder has not opted in, so is not approved');
        if (!(token.Flags & MPTokenFlags.lsfMPTAuthorized))
            return noop('holder is not approved');
        const result = await this.#submit({
            TransactionType: 'MPTokenAuthorize',
            Account: this.#wallet.classicAddress,
            MPTokenIssuanceID: this.issuanceId,
            Holder: address,
            Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
        });
        this.#audit({ action: 'revoke-approval', holder: address, ...txRef(result) });
        return submitted(result);
    }
    async #freezeHolder(address) {
        const token = await this.#requireMPToken(address);
        if (token.Flags & MPTokenFlags.lsfMPTLocked)
            return noop('holder is already frozen');
        const result = await this.#submit(this.#lockTx(MPTokenIssuanceSetFlags.tfMPTLock, address));
        this.#audit({ action: 'freeze-holder', holder: address, ...txRef(result) });
        return submitted(result);
    }
    async #clawbackAll(address) {
        const token = await getMPTokenEntry(this.#client, this.issuanceId, address);
        if (!token || parseLedgerAmount(token.MPTAmount) === 0n)
            return noop('holder has no balance');
        // Asking for the maximum amount makes the ledger claw back the whole balance.
        return this.#clawback(address, MAX_MPT_AMOUNT, 'clawback-all');
    }
    async #clawback(address, units, action) {
        const result = await this.#submit({
            TransactionType: 'Clawback',
            Account: this.#wallet.classicAddress,
            Holder: address,
            Amount: this.#mptAmount(units),
        });
        const clawedBack = fromBaseUnits(mptBalanceDecrease(result.meta, address, this.issuanceId), this.assetScale);
        this.#audit({ action, holder: address, amount: clawedBack, ...txRef(result) });
        return { ...submitted(result), clawedBack };
    }
    #lockTx(flag, holder) {
        return {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.#wallet.classicAddress,
            MPTokenIssuanceID: this.issuanceId,
            Flags: flag,
            ...(holder !== undefined && { Holder: holder }),
        };
    }
    async #submit(tx) {
        return submitOrThrow(this.#client, this.#wallet, tx, this.#networkId);
    }
    async #issuance() {
        const issuance = await getIssuanceEntry(this.#client, this.issuanceId);
        if (!issuance)
            throw new IssuanceConfigurationError(`Issuance ${this.issuanceId} no longer exists`);
        return issuance;
    }
    async #requireMPToken(address) {
        const token = await getMPTokenEntry(this.#client, this.issuanceId, address);
        if (!token) {
            throw new PolicyViolationError(`${address} has not opted in to hold ${this.issuanceId} (no MPToken entry)`);
        }
        return token;
    }
    async #assertNotBanned(address, action) {
        if (await this.#bans.isBanned(address))
            throw new PolicyViolationError(`Refusing to ${action} banned address ${address}`);
    }
    #assertHolderAddress(address) {
        if (!isValidClassicAddress(address))
            throw new InvalidInputError(`Invalid classic address ${address}`);
        if (address === this.#wallet.classicAddress)
            throw new InvalidInputError('The issuer cannot be a holder');
    }
    #positiveUnits(amount) {
        const units = toBaseUnits(amount, this.assetScale);
        if (units === 0n)
            throw new InvalidInputError('Amount must be greater than zero');
        return units;
    }
    #mptAmount(units) {
        return { mpt_issuance_id: this.issuanceId, value: units.toString() };
    }
    #audit(event) {
        try {
            this.#onAudit?.({ issuanceId: this.issuanceId, ...event });
        }
        catch {
            // An audit sink failure must not hide the outcome of a transaction that already validated.
        }
    }
    /** Runs `fn` after all previously queued operations, one at a time. */
    #exclusive(fn) {
        const run = this.#queue.then(fn, fn);
        this.#queue = run.catch(() => undefined);
        return run;
    }
}
function submitted(result) {
    return { status: 'submitted', hash: result.hash, ledgerIndex: result.ledgerIndex };
}
function noop(reason) {
    return { status: 'noop', reason };
}
function txRef(result) {
    return { txHash: result.hash, ledgerIndex: result.ledgerIndex };
}
/** Amount by which a holder's MPT balance fell in a transaction, read from its metadata. */
function mptBalanceDecrease(meta, holder, issuanceId) {
    for (const node of meta.AffectedNodes) {
        if (!('ModifiedNode' in node))
            continue;
        const { LedgerEntryType, FinalFields, PreviousFields } = node.ModifiedNode;
        if (LedgerEntryType !== 'MPToken' || FinalFields?.['Account'] !== holder)
            continue;
        if (String(FinalFields['MPTokenIssuanceID']).toUpperCase() !== issuanceId)
            continue;
        if (!PreviousFields || !('MPTAmount' in PreviousFields))
            return 0n;
        return parseLedgerAmount(PreviousFields['MPTAmount']) - parseLedgerAmount(FinalFields['MPTAmount']);
    }
    return 0n;
}
function serializable(status) {
    return { ...status, balanceBaseUnits: status.balanceBaseUnits.toString() };
}
//# sourceMappingURL=issuer.js.map