"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MptIssuer = void 0;
const xrpl_1 = require("xrpl");
const constants_1 = require("./constants");
const errors_1 = require("./errors");
const submit_1 = require("./submit");
function assertValidAddress(address, label = "address") {
    if (!(0, xrpl_1.isValidAddress)(address)) {
        throw new errors_1.IssuerInputError(`Invalid XRPL ${label}: ${address}`);
    }
}
function assertPositiveIntegerString(value, label = "value") {
    if (!/^[1-9][0-9]*$/.test(value)) {
        throw new errors_1.IssuerInputError(`${label} must be a positive integer string (in base units), got: ${value}`);
    }
}
/**
 * Issuer-side compliance controls for a Multi-Purpose Token (MPT) issuance
 * on the XRP Ledger: allowlisting, clawback, per-holder freeze, global
 * freeze, and address bans.
 *
 * One instance manages one issuer account. Construct with a connected
 * `Client` and the issuer's `Wallet`; every method signs and submits with
 * that wallet and waits for validation before resolving. Every method
 * throws `IssuerTransactionError` on anything short of `tesSUCCESS` in a
 * validated ledger — callers should not need to inspect result codes
 * themselves.
 */
class MptIssuer {
    client;
    issuerWallet;
    constructor(client, issuerWallet) {
        this.client = client;
        this.issuerWallet = issuerWallet;
    }
    get address() {
        return this.issuerWallet.address;
    }
    /** Creates a new MPT issuance with allowlist, clawback and lock (freeze) all enabled. */
    async createIssuance(params = {}) {
        if (params.maximumAmount !== undefined) {
            assertPositiveIntegerString(params.maximumAmount, "maximumAmount");
        }
        const tx = {
            TransactionType: "MPTokenIssuanceCreate",
            Account: this.issuerWallet.address,
            AssetScale: params.assetScale ?? constants_1.DEFAULT_ASSET_SCALE,
            MaximumAmount: params.maximumAmount ?? constants_1.DEFAULT_MAXIMUM_AMOUNT,
            TransferFee: params.transferFee ?? constants_1.DEFAULT_TRANSFER_FEE,
            Flags: {
                // Allowlist: holders must be individually approved before they can hold the token.
                tfMPTRequireAuth: true,
                // Freeze: enables both per-holder and global locking.
                tfMPTCanLock: true,
                // Clawback: issuer can reclaim tokens from any holder.
                tfMPTCanClawback: true,
                // Lets approved holders transfer to each other, not just to/from the issuer.
                tfMPTCanTransfer: true,
            },
        };
        if (params.metadata !== undefined) {
            tx.MPTokenMetadata = (0, xrpl_1.encodeMPTokenMetadata)(params.metadata);
        }
        const response = await this.client.submitAndWait(tx, { wallet: this.issuerWallet });
        (0, submit_1.assertTesSuccess)(response);
        const meta = response.result.meta;
        if (meta === undefined || typeof meta === "string") {
            throw new errors_1.IssuerTransactionError("MPTokenIssuanceCreate validated but returned no parsed metadata", tx.TransactionType, "tesSUCCESS", response.result.hash);
        }
        const issuanceId = meta.mpt_issuance_id;
        if (issuanceId === undefined) {
            throw new errors_1.IssuerTransactionError("MPTokenIssuanceCreate validated but returned no mpt_issuance_id", tx.TransactionType, "tesSUCCESS", response.result.hash);
        }
        return { issuanceId, hash: response.result.hash };
    }
    /**
     * Allowlist: approves a holder to hold this issuance. The holder must
     * already have opted in (see `optInHolder`) before this call succeeds.
     */
    async approveHolder(issuanceId, holder) {
        assertValidAddress(holder, "holder address");
        const tx = {
            TransactionType: "MPTokenAuthorize",
            Account: this.issuerWallet.address,
            MPTokenIssuanceID: issuanceId,
            Holder: holder,
        };
        return this.submit(tx);
    }
    /**
     * Allowlist: revokes a holder's approval, without touching their balance
     * or freeze state. After this, the holder cannot receive the token again
     * (but keeps whatever balance they already hold, unless separately
     * clawed back). Used internally by `banHolder`.
     */
    async revokeHolderApproval(issuanceId, holder) {
        assertValidAddress(holder, "holder address");
        const tx = {
            TransactionType: "MPTokenAuthorize",
            Account: this.issuerWallet.address,
            MPTokenIssuanceID: issuanceId,
            Holder: holder,
            Flags: { tfMPTUnauthorize: true },
        };
        return this.submit(tx);
    }
    /** Sends tokens from the issuer to an approved, non-frozen holder. */
    async send(issuanceId, holder, value) {
        assertValidAddress(holder, "holder address");
        assertPositiveIntegerString(value, "value");
        const tx = {
            TransactionType: "Payment",
            Account: this.issuerWallet.address,
            Destination: holder,
            Amount: { mpt_issuance_id: issuanceId, value },
        };
        return this.submit(tx);
    }
    /** Claws back a specific amount from a holder's balance. */
    async clawback(issuanceId, holder, value) {
        assertValidAddress(holder, "holder address");
        assertPositiveIntegerString(value, "value");
        const tx = {
            TransactionType: "Clawback",
            Account: this.issuerWallet.address,
            Holder: holder,
            Amount: { mpt_issuance_id: issuanceId, value },
        };
        return this.submit(tx);
    }
    /** Claws back a holder's entire current balance. No-op (returns null) if they hold zero. */
    async clawbackAll(issuanceId, holder) {
        const state = await this.getHolderState(issuanceId, holder);
        if (state.balance === "0") {
            return null;
        }
        return this.clawback(issuanceId, holder, state.balance);
    }
    /** Freezes a single holder: they can neither send nor receive the token. */
    async freezeHolder(issuanceId, holder) {
        assertValidAddress(holder, "holder address");
        return this.setLock(issuanceId, holder, true);
    }
    /** Lifts a single holder's freeze. */
    async unfreezeHolder(issuanceId, holder) {
        assertValidAddress(holder, "holder address");
        return this.setLock(issuanceId, holder, false);
    }
    /** Freezes all movement of the token for every holder (emergency stop). */
    async globalFreeze(issuanceId) {
        return this.setLock(issuanceId, undefined, true);
    }
    /** Lifts the global freeze. */
    async globalUnfreeze(issuanceId) {
        return this.setLock(issuanceId, undefined, false);
    }
    /**
     * Bans a holder: claws back their entire balance, freezes them, and
     * revokes their allowlist approval so they can never receive the token
     * again. Idempotent-ish — safe to call on a holder who already holds
     * zero, is already frozen, etc.
     */
    async banHolder(issuanceId, holder) {
        assertValidAddress(holder, "holder address");
        const results = [];
        const clawed = await this.clawbackAll(issuanceId, holder);
        if (clawed !== null) {
            results.push(clawed);
        }
        results.push(await this.freezeHolder(issuanceId, holder));
        results.push(await this.revokeHolderApproval(issuanceId, holder));
        return results;
    }
    /** Reads the current compliance-relevant state of the issuance itself. */
    async getIssuanceState(issuanceId) {
        const node = await (0, xrpl_1.fetchMPTokenIssuance)(this.client, issuanceId, "validated");
        const flags = node.Flags;
        return {
            issuanceId,
            issuer: node.Issuer,
            outstandingAmount: node.OutstandingAmount,
            maximumAmount: node.MaximumAmount,
            assetScale: node.AssetScale,
            requireAuth: (flags & 0x00000004) !== 0, // lsfMPTRequireAuth
            canClawback: (flags & 0x00000040) !== 0, // lsfMPTCanClawback
            canLock: (flags & 0x00000002) !== 0, // lsfMPTCanLock
            canTransfer: (flags & 0x00000020) !== 0, // lsfMPTCanTransfer
            globallyLocked: (flags & 0x00000001) !== 0, // lsfMPTLocked
        };
    }
    /** Reads the current compliance-relevant state of one holder. */
    async getHolderState(issuanceId, holder) {
        assertValidAddress(holder, "holder address");
        let node;
        try {
            node = await (0, xrpl_1.fetchMPToken)(this.client, holder, issuanceId, "validated");
        }
        catch (err) {
            if (isEntryNotFoundError(err)) {
                return { address: holder, exists: false, balance: "0", authorized: false, frozen: false };
            }
            throw err;
        }
        return {
            address: holder,
            exists: true,
            // rippled omits MPTAmount from the ledger entry entirely when the balance is zero.
            balance: node.MPTAmount ?? "0",
            authorized: (node.Flags & constants_1.MPTOKEN_LSF_AUTHORIZED) !== 0,
            frozen: (node.Flags & constants_1.MPTOKEN_LSF_LOCKED) !== 0,
        };
    }
    async setLock(issuanceId, holder, lock) {
        const tx = {
            TransactionType: "MPTokenIssuanceSet",
            Account: this.issuerWallet.address,
            MPTokenIssuanceID: issuanceId,
            Flags: lock ? { tfMPTLock: true } : { tfMPTUnlock: true },
        };
        if (holder !== undefined) {
            tx.Holder = holder;
        }
        return this.submit(tx);
    }
    async submit(tx) {
        const response = await this.client.submitAndWait(tx, { wallet: this.issuerWallet });
        (0, submit_1.assertTesSuccess)(response);
        return { hash: response.result.hash, ledgerIndex: response.result.ledger_index };
    }
}
exports.MptIssuer = MptIssuer;
function isEntryNotFoundError(err) {
    if (!(err instanceof Error))
        return false;
    const data = err.data;
    if (data === null || typeof data !== "object")
        return false;
    return data.error === "entryNotFound";
}
//# sourceMappingURL=issuer.js.map