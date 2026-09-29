"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MptIssuer = exports.MptIssuerError = void 0;
const xrpl_1 = require("xrpl");
/**
 * The MPToken ledger object (per-holder) does not have an exported flag
 * parser in xrpl.js, so the two flag bits are reproduced here from the
 * MPToken ledger entry spec (xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken).
 */
const MPTOKEN_LSF_LOCKED = 0x00000001;
const MPTOKEN_LSF_AUTHORIZED = 0x00000002;
/** Largest amount representable in an MPT balance field (2^63 - 1). */
const MAX_MPT_AMOUNT = '9223372036854775807';
class MptIssuerError extends Error {
    transactionResult;
    details;
    constructor(message, transactionResult, details) {
        super(message);
        this.transactionResult = transactionResult;
        this.details = details;
        this.name = 'MptIssuerError';
    }
}
exports.MptIssuerError = MptIssuerError;
/**
 * Reusable issuer-side controls for a single regulated, allow-listed Multi-Purpose
 * Token (MPT) issuance. Wraps the raw MPTokenIssuanceCreate / MPTokenAuthorize /
 * MPTokenIssuanceSet / Clawback / Payment transactions with the compliance
 * workflows a stablecoin-style issuer needs: allow-listing, per-holder and
 * global freeze, clawback, and permanent bans.
 *
 * One instance is bound to one issuer wallet; callers may manage multiple
 * issuances (e.g. multiple tokens) by calling `createIssuance` more than once
 * and passing the resulting `issuanceId` back into the other methods.
 */
class MptIssuer {
    client;
    issuer;
    constructor(client, issuer) {
        this.client = client;
        this.issuer = issuer;
    }
    get issuerAddress() {
        return this.issuer.address;
    }
    /**
     * Creates a new MPT issuance with every compliance control enabled:
     * - `tfMPTRequireAuth` so only issuer-approved (allow-listed) holders can hold it.
     * - `tfMPTCanLock` so holders (or the whole issuance) can be frozen and unfrozen.
     * - `tfMPTCanClawback` so the issuer can claw back tokens from any holder.
     */
    async createIssuance(options = {}) {
        const flags = {
            tfMPTCanLock: true,
            tfMPTRequireAuth: true,
            tfMPTCanClawback: true,
            tfMPTCanTransfer: options.allowHolderToHolderTransfer ?? true,
        };
        const tx = {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: this.issuer.address,
            Flags: flags,
        };
        if (options.assetScale !== undefined) {
            tx.AssetScale = options.assetScale;
        }
        if (options.maximumAmount !== undefined) {
            tx.MaximumAmount = options.maximumAmount;
        }
        if (options.transferFeeBasisPoints !== undefined) {
            tx.TransferFee = options.transferFeeBasisPoints;
        }
        if (options.metadata !== undefined) {
            tx.MPTokenMetadata = options.metadata;
        }
        const response = await this.submit(tx, this.issuer);
        const meta = response.result.meta;
        const issuanceId = meta != null && typeof meta !== 'string' ? meta.mpt_issuance_id : undefined;
        if (issuanceId == null) {
            throw new MptIssuerError('MPTokenIssuanceCreate succeeded but the response did not include an mpt_issuance_id', undefined, response.result);
        }
        return { issuanceId, txHash: response.result.hash };
    }
    // ---------------------------------------------------------------------
    // Allow-list (KYC approval)
    // ---------------------------------------------------------------------
    /**
     * Holder-side opt-in: signals that `holder` is willing to hold this MPT.
     * This must happen before the issuer can approve the holder, and creates
     * a zero-balance, unauthorized MPToken entry on the holder's account.
     */
    async requestHolderOptIn(holder, issuanceId) {
        const tx = {
            TransactionType: 'MPTokenAuthorize',
            Account: holder.address,
            MPTokenIssuanceID: issuanceId,
        };
        return this.submit(tx, holder);
    }
    /**
     * Issuer-side approval: grants `holderAddress` permission to hold the MPT
     * (sets `lsfMPTAuthorized` on their MPToken entry). Represents the outcome
     * of a successful KYC check. The holder must have already opted in via
     * `requestHolderOptIn`.
     */
    async approveHolder(issuanceId, holderAddress) {
        const tx = {
            TransactionType: 'MPTokenAuthorize',
            Account: this.issuer.address,
            MPTokenIssuanceID: issuanceId,
            Holder: holderAddress,
        };
        return this.submit(tx, this.issuer);
    }
    /**
     * Issuer-side revocation: unsets `lsfMPTAuthorized` on `holderAddress`'s
     * MPToken entry, without touching their balance. Because the issuance
     * requires authorization, a revoked holder can no longer send or receive
     * the token until re-approved. Used as the second half of `banHolder`.
     */
    async revokeHolderAuthorization(issuanceId, holderAddress) {
        const tx = {
            TransactionType: 'MPTokenAuthorize',
            Account: this.issuer.address,
            MPTokenIssuanceID: issuanceId,
            Holder: holderAddress,
            Flags: { tfMPTUnauthorize: true },
        };
        return this.submit(tx, this.issuer);
    }
    // ---------------------------------------------------------------------
    // Freeze (per-holder and global)
    // ---------------------------------------------------------------------
    /** Freezes a single holder: they can no longer send or receive the MPT. */
    async freezeHolder(issuanceId, holderAddress) {
        return this.setLock(issuanceId, true, holderAddress);
    }
    /** Reverses `freezeHolder`. */
    async unfreezeHolder(issuanceId, holderAddress) {
        return this.setLock(issuanceId, false, holderAddress);
    }
    /** Freezes all movement of the token, for every holder, issuance-wide. */
    async globalFreeze(issuanceId) {
        return this.setLock(issuanceId, true);
    }
    /** Reverses `globalFreeze`. */
    async globalUnfreeze(issuanceId) {
        return this.setLock(issuanceId, false);
    }
    async setLock(issuanceId, lock, holderAddress) {
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.issuer.address,
            MPTokenIssuanceID: issuanceId,
            Flags: lock ? { tfMPTLock: true } : { tfMPTUnlock: true },
        };
        if (holderAddress !== undefined) {
            tx.Holder = holderAddress;
        }
        return this.submit(tx, this.issuer);
    }
    // ---------------------------------------------------------------------
    // Clawback and bans
    // ---------------------------------------------------------------------
    /** Claws back an exact amount of the token from a holder's balance. */
    async clawback(issuanceId, holderAddress, value) {
        const tx = {
            TransactionType: 'Clawback',
            Account: this.issuer.address,
            Holder: holderAddress,
            Amount: { mpt_issuance_id: issuanceId, value },
        };
        return this.submit(tx, this.issuer);
    }
    /**
     * Claws back the holder's entire current balance. A clawback `Amount` that
     * exceeds the actual balance simply claws back everything, so this is safe
     * to call even if the balance changes concurrently; if the holder's balance
     * is already zero, no transaction is submitted.
     */
    async clawbackAll(issuanceId, holderAddress) {
        const balance = await this.getBalance(issuanceId, holderAddress);
        if (BigInt(balance) === 0n) {
            return undefined;
        }
        return this.clawback(issuanceId, holderAddress, MAX_MPT_AMOUNT);
    }
    /**
     * Permanently bans a holder: claws back their entire balance (if any) and
     * revokes their authorization, so they end up holding none of the token
     * and cannot be paid it again unless explicitly re-approved.
     */
    async banHolder(issuanceId, holderAddress) {
        await this.clawbackAll(issuanceId, holderAddress);
        await this.revokeHolderAuthorization(issuanceId, holderAddress);
    }
    // ---------------------------------------------------------------------
    // Payments
    // ---------------------------------------------------------------------
    /** Sends `value` of the MPT from `from` to `destination`. */
    async pay(from, issuanceId, destination, value) {
        const tx = {
            TransactionType: 'Payment',
            Account: from.address,
            Destination: destination,
            Amount: { mpt_issuance_id: issuanceId, value },
        };
        return this.submit(tx, from);
    }
    /** Issues (pays) `value` of the MPT from the issuer to `destination`. */
    async issueTo(issuanceId, destination, value) {
        return this.pay(this.issuer, issuanceId, destination, value);
    }
    // ---------------------------------------------------------------------
    // Ledger state helpers
    // ---------------------------------------------------------------------
    async getIssuance(issuanceId) {
        try {
            const response = await this.client.request({
                command: 'ledger_entry',
                mpt_issuance: issuanceId,
                ledger_index: 'validated',
            });
            return response.result.node;
        }
        catch (error) {
            if (isEntryNotFound(error)) {
                return null;
            }
            throw error;
        }
    }
    async getMPToken(issuanceId, holderAddress) {
        try {
            const response = await this.client.request({
                command: 'ledger_entry',
                mptoken: { mpt_issuance_id: issuanceId, account: holderAddress },
                ledger_index: 'validated',
            });
            return response.result.node;
        }
        catch (error) {
            if (isEntryNotFound(error)) {
                return null;
            }
            throw error;
        }
    }
    async getBalance(issuanceId, holderAddress) {
        const mptoken = await this.getMPToken(issuanceId, holderAddress);
        return mptoken?.MPTAmount ?? '0';
    }
    async isGloballyFrozen(issuanceId) {
        const issuance = await this.getIssuance(issuanceId);
        if (issuance == null) {
            throw new MptIssuerError(`MPTokenIssuance ${issuanceId} not found`);
        }
        return Boolean((0, xrpl_1.parseMPTokenIssuanceFlags)(issuance.Flags).lsfMPTLocked);
    }
    async isHolderFrozen(issuanceId, holderAddress) {
        const mptoken = await this.getMPToken(issuanceId, holderAddress);
        if (mptoken == null) {
            return false;
        }
        // eslint-disable-next-line no-bitwise -- bit flag check
        return (mptoken.Flags & MPTOKEN_LSF_LOCKED) !== 0;
    }
    async isHolderAuthorized(issuanceId, holderAddress) {
        const mptoken = await this.getMPToken(issuanceId, holderAddress);
        if (mptoken == null) {
            return false;
        }
        // eslint-disable-next-line no-bitwise -- bit flag check
        return (mptoken.Flags & MPTOKEN_LSF_AUTHORIZED) !== 0;
    }
    // ---------------------------------------------------------------------
    // Submission plumbing
    // ---------------------------------------------------------------------
    async submit(tx, wallet) {
        (0, xrpl_1.validate)(tx);
        const response = await this.client.submitAndWait(tx, {
            wallet,
            autofill: true,
        });
        const meta = response.result.meta;
        const transactionResult = meta != null && typeof meta !== 'string' ? meta.TransactionResult : undefined;
        if (transactionResult !== 'tesSUCCESS') {
            throw new MptIssuerError(`${tx.TransactionType} failed with result ${String(transactionResult)}`, transactionResult, response.result);
        }
        return response;
    }
}
exports.MptIssuer = MptIssuer;
function isEntryNotFound(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'data' in error &&
        typeof error.data === 'object' &&
        error.data?.error === 'entryNotFound');
}
//# sourceMappingURL=mptIssuer.js.map