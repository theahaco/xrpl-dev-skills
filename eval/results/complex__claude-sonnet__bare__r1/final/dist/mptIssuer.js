"use strict";
/**
 * Reusable issuer-side module for a regulated, stablecoin-style token on the
 * XRP Ledger, built on Multi-Purpose Tokens (MPTs).
 *
 * Compliance controls implemented:
 *  - Allowlist: `tfMPTRequireAuth` on the issuance + per-holder authorization
 *    via `MPTokenAuthorize`. Only authorized holders can hold a balance.
 *  - Clawback: `tfMPTCanClawback` on the issuance + `Clawback` transactions.
 *  - Bans: clawback the holder's full balance, then revoke their
 *    authorization so they can never receive the token again.
 *  - Per-holder freeze: `MPTokenIssuanceSet` with a `Holder` field and
 *    `tfMPTLock` / `tfMPTUnlock`.
 *  - Global freeze: `MPTokenIssuanceSet` with no `Holder` field and
 *    `tfMPTLock` / `tfMPTUnlock`.
 *
 * All issuer-signing operations live on the `MPTIssuer` class. Opting a
 * holder in (`optInToIssuance`) is the one operation a holder's own wallet
 * performs, not the issuer; it is exported separately for test/demo use.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MPTIssuer = exports.MPTIssuerError = void 0;
exports.optInToIssuance = optInToIssuance;
const xrpl_1 = require("xrpl");
/**
 * Bit flags on the per-holder `MPToken` ledger object. xrpl.js does not
 * export these (only the issuance-level flags), so they are defined here
 * per the XRPL MPT ledger format spec.
 */
const MPTOKEN_LEDGER_FLAGS = {
    LOCKED: 0x00000001,
    AUTHORIZED: 0x00000002,
};
class MPTIssuerError extends Error {
    constructor(message, options) {
        super(message);
        this.name = 'MPTIssuerError';
        this.transactionType = options?.transactionType;
        this.resultCode = options?.resultCode;
    }
}
exports.MPTIssuerError = MPTIssuerError;
function getResultCode(meta) {
    if (meta == null || typeof meta === 'string') {
        return undefined;
    }
    return meta.TransactionResult;
}
/**
 * The issuer-side MPT controller. One instance manages exactly one
 * MPTokenIssuance, signed for by the issuer's wallet.
 */
class MPTIssuer {
    constructor(client, issuerWallet, issuanceId) {
        this.client = client;
        this.wallet = issuerWallet;
        this.issuanceId = issuanceId;
    }
    /**
     * Creates a new MPTokenIssuance with the compliance-control flags enabled
     * (allowlist, clawback, lock/freeze) and returns a ready-to-use MPTIssuer.
     */
    static async create(client, issuerWallet, params = {}) {
        const transferable = params.transferable ?? true;
        let flags = xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanLock |
            xrpl_1.MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
            xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanClawback;
        if (transferable) {
            flags |= xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanTransfer;
        }
        const tx = {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: issuerWallet.address,
            Flags: flags,
            ...(params.assetScale !== undefined && { AssetScale: params.assetScale }),
            ...(params.maximumAmount !== undefined && {
                MaximumAmount: params.maximumAmount,
            }),
            ...(transferable &&
                params.transferFee !== undefined && { TransferFee: params.transferFee }),
            ...(params.metadataHex !== undefined && {
                MPTokenMetadata: params.metadataHex,
            }),
        };
        const response = await MPTIssuer.submit(client, issuerWallet, tx);
        const meta = response.result.meta;
        const issuanceId = meta != null && typeof meta !== 'string'
            ? meta
                .mpt_issuance_id
            : undefined;
        if (!issuanceId) {
            throw new MPTIssuerError('MPTokenIssuanceCreate succeeded but no mpt_issuance_id was returned', { transactionType: 'MPTokenIssuanceCreate' });
        }
        return new MPTIssuer(client, issuerWallet, issuanceId);
    }
    static async submit(client, wallet, tx) {
        const response = await client.submitAndWait(tx, { wallet });
        const resultCode = getResultCode(response.result.meta);
        if (resultCode !== 'tesSUCCESS') {
            throw new MPTIssuerError(`${tx.TransactionType} failed with result ${resultCode ?? 'unknown'}`, { transactionType: tx.TransactionType, resultCode });
        }
        return response;
    }
    submit(tx) {
        return MPTIssuer.submit(this.client, this.wallet, tx);
    }
    // ---------------------------------------------------------------------
    // Allowlist
    // ---------------------------------------------------------------------
    /**
     * Authorizes a holder who has already opted in (via {@link optInToIssuance}),
     * allowing them to hold and receive this MPT. Required before any payment
     * to that holder will succeed, since the issuance was created with
     * `tfMPTRequireAuth`.
     */
    async approveHolder(holderAddress) {
        const tx = {
            TransactionType: 'MPTokenAuthorize',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holderAddress,
        };
        return this.submit(tx);
    }
    /**
     * Revokes a holder's authorization. Their existing balance is untouched by
     * this call alone; combine with {@link clawback} (see {@link ban}) to also
     * remove funds. Does not delete the holder's MPToken object.
     */
    async revokeHolderAuthorization(holderAddress) {
        const tx = {
            TransactionType: 'MPTokenAuthorize',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holderAddress,
            Flags: xrpl_1.MPTokenAuthorizeFlags.tfMPTUnauthorize,
        };
        return this.submit(tx);
    }
    // ---------------------------------------------------------------------
    // Distribution
    // ---------------------------------------------------------------------
    /** Sends `amount` (base units, as a string) of this MPT from the issuer to `to`. */
    async send(to, amount) {
        const tx = {
            TransactionType: 'Payment',
            Account: this.wallet.address,
            Destination: to,
            Amount: { mpt_issuance_id: this.issuanceId, value: amount },
        };
        return this.submit(tx);
    }
    // ---------------------------------------------------------------------
    // Clawback
    // ---------------------------------------------------------------------
    /** Claws back `amount` (base units, as a string) of this MPT from `holder`. */
    async clawback(holder, amount) {
        const tx = {
            TransactionType: 'Clawback',
            Account: this.wallet.address,
            Holder: holder,
            Amount: { mpt_issuance_id: this.issuanceId, value: amount },
        };
        return this.submit(tx);
    }
    // ---------------------------------------------------------------------
    // Bans
    // ---------------------------------------------------------------------
    /**
     * Bans a holder: claws back their entire balance (if any) and revokes
     * their authorization, so they end up holding none of the token and
     * cannot be paid it again (payments to an unauthorized holder are
     * rejected while `tfMPTRequireAuth` is set on the issuance).
     */
    async ban(holderAddress) {
        const responses = [];
        const holderState = await this.getHolderState(holderAddress);
        if (BigInt(holderState.balance) > 0n) {
            responses.push(await this.clawback(holderAddress, holderState.balance));
        }
        responses.push(await this.revokeHolderAuthorization(holderAddress));
        return responses;
    }
    // ---------------------------------------------------------------------
    // Per-holder freeze
    // ---------------------------------------------------------------------
    /**
     * Freezes an individual holder: they can no longer send this MPT to, or
     * receive it from, any other holder (`tecLOCKED`). Per the MPT protocol
     * design, a lock does not block movement directly to/from the issuer
     * (e.g. redemption or issuer-driven distribution/clawback still work) —
     * it blocks the holder from moving the token around the rest of the
     * ecosystem while a compliance issue is investigated.
     */
    async freezeHolder(holderAddress) {
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holderAddress,
            Flags: xrpl_1.MPTokenIssuanceSetFlags.tfMPTLock,
        };
        return this.submit(tx);
    }
    /** Lifts an individual freeze on a holder. */
    async unfreezeHolder(holderAddress) {
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holderAddress,
            Flags: xrpl_1.MPTokenIssuanceSetFlags.tfMPTUnlock,
        };
        return this.submit(tx);
    }
    // ---------------------------------------------------------------------
    // Global freeze
    // ---------------------------------------------------------------------
    /**
     * Freezes all holder-to-holder movement of this MPT (`tecLOCKED`), e.g.
     * during an incident. As with per-holder locks, issuer-to-holder and
     * holder-to-issuer payments are unaffected, so the issuer retains the
     * ability to manage the token (clawback, distribute) while the freeze
     * is in effect.
     */
    async globalFreeze() {
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Flags: xrpl_1.MPTokenIssuanceSetFlags.tfMPTLock,
        };
        return this.submit(tx);
    }
    /** Lifts the global freeze on this MPT. */
    async globalUnfreeze() {
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Flags: xrpl_1.MPTokenIssuanceSetFlags.tfMPTUnlock,
        };
        return this.submit(tx);
    }
    // ---------------------------------------------------------------------
    // Read helpers
    // ---------------------------------------------------------------------
    /** Fetches the MPTokenIssuance ledger object and decodes its flags. */
    async getIssuanceState() {
        const response = await this.client.request({
            command: 'ledger_entry',
            mpt_issuance: this.issuanceId,
            ledger_index: 'validated',
        });
        const node = response.result.node;
        const flags = (0, xrpl_1.parseMPTokenIssuanceFlags)(node.Flags);
        return {
            issuanceId: this.issuanceId,
            issuer: node.Issuer,
            globallyLocked: flags.lsfMPTLocked ?? false,
            requiresAuth: flags.lsfMPTRequireAuth ?? false,
            canClawback: flags.lsfMPTCanClawback ?? false,
            canLock: flags.lsfMPTCanLock ?? false,
            canTransfer: flags.lsfMPTCanTransfer ?? false,
            outstandingAmount: node.OutstandingAmount,
            ...(node.MaximumAmount !== undefined && {
                maximumAmount: node.MaximumAmount,
            }),
            ...(node.AssetScale !== undefined && { assetScale: node.AssetScale }),
        };
    }
    /**
     * Fetches a holder's MPToken ledger object (their opt-in/authorization/
     * balance/lock record for this issuance), or `undefined` if they have
     * never opted in.
     */
    async getHolderMPToken(holderAddress) {
        try {
            const response = await this.client.request({
                command: 'ledger_entry',
                mptoken: { mpt_issuance_id: this.issuanceId, account: holderAddress },
                ledger_index: 'validated',
            });
            return response.result.node;
        }
        catch (error) {
            if (isEntryNotFoundError(error)) {
                return undefined;
            }
            throw error;
        }
    }
    /** Convenience summary of a holder's state (balance, authorized?, locked?). */
    async getHolderState(holderAddress) {
        const mptoken = await this.getHolderMPToken(holderAddress);
        if (!mptoken) {
            return {
                address: holderAddress,
                exists: false,
                authorized: false,
                locked: false,
                balance: '0',
            };
        }
        return {
            address: holderAddress,
            exists: true,
            authorized: isFlagSet(mptoken.Flags, MPTOKEN_LEDGER_FLAGS.AUTHORIZED),
            locked: isFlagSet(mptoken.Flags, MPTOKEN_LEDGER_FLAGS.LOCKED),
            balance: mptoken.MPTAmount ?? '0',
        };
    }
    async getBalance(holderAddress) {
        const state = await this.getHolderState(holderAddress);
        return state.balance;
    }
}
exports.MPTIssuer = MPTIssuer;
function isFlagSet(flags, bit) {
    // eslint-disable-next-line no-bitwise -- checking a single bit against a ledger flags integer
    return (flags & bit) === bit;
}
function isEntryNotFoundError(error) {
    if (typeof error !== 'object' || error === null) {
        return false;
    }
    const data = error.data;
    const message = error.message;
    return data?.error === 'entryNotFound' || message === 'entryNotFound';
}
/**
 * Opts a holder in to an MPTokenIssuance. This transaction must be signed by
 * the holder's own wallet (not the issuer's) — it is the on-chain equivalent
 * of a customer saying "I want to be able to hold this token." The issuer
 * must still call {@link MPTIssuer.approveHolder} afterwards before the
 * holder can receive a balance, since the issuance requires authorization.
 */
async function optInToIssuance(client, holderWallet, issuanceId) {
    const tx = {
        TransactionType: 'MPTokenAuthorize',
        Account: holderWallet.address,
        MPTokenIssuanceID: issuanceId,
    };
    const response = await client.submitAndWait(tx, { wallet: holderWallet });
    const resultCode = getResultCode(response.result.meta);
    if (resultCode !== 'tesSUCCESS') {
        throw new MPTIssuerError(`MPTokenAuthorize (opt-in) failed with result ${resultCode ?? 'unknown'}`, { transactionType: 'MPTokenAuthorize', resultCode });
    }
    return response;
}
//# sourceMappingURL=mptIssuer.js.map