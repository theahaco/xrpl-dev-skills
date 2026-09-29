"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MptIssuer = void 0;
exports.optInHolder = optInHolder;
const xrpl_1 = require("xrpl");
/**
 * Bit flags on the per-holder MPToken ledger object (distinct from the
 * MPTokenIssuance flags, which xrpl.js already exposes via
 * parseMPTokenIssuanceFlags).
 */
const MPTOKEN_FLAG_LOCKED = 0x00000001;
const MPTOKEN_FLAG_AUTHORIZED = 0x00000002;
function assertAddress(address, label) {
    if (!(0, xrpl_1.isValidClassicAddress)(address)) {
        throw new Error(`${label} is not a valid classic XRPL address: "${address}"`);
    }
}
function assertPositiveIntegerString(value, label) {
    if (!/^[1-9][0-9]*$/.test(value)) {
        throw new Error(`${label} must be a positive integer string in base units, got: "${value}"`);
    }
}
function isEntryNotFoundError(error) {
    if (!(error instanceof xrpl_1.RippledError)) {
        return false;
    }
    const data = error.data;
    return data?.error === 'entryNotFound';
}
function extractResultCode(meta) {
    if (meta == null) {
        throw new Error('Transaction response is missing metadata; cannot confirm outcome');
    }
    return typeof meta === 'string' ? meta : meta.TransactionResult;
}
/**
 * Issuer-side control surface for a single Multi-Purpose Token issuance,
 * built for a regulated / stablecoin-style deployment:
 *
 *  - Allowlist: the issuance is created with tfMPTRequireAuth, so only
 *    holders the issuer explicitly authorizes can hold a balance.
 *  - Clawback: created with tfMPTCanClawback.
 *  - Per-holder and global freeze: created with tfMPTCanLock.
 *  - Bans: implemented as clawback-to-zero + revoking the holder's
 *    authorization, so a banned address can neither hold nor receive
 *    the token again.
 *
 * All state-changing methods submit a signed transaction and wait for
 * validated, tesSUCCESS confirmation before resolving; on any other
 * outcome they throw.
 */
class MptIssuer {
    client;
    wallet;
    mptIssuanceId;
    constructor(client, issuerWallet, issuanceId) {
        this.client = client;
        this.wallet = issuerWallet;
        this.mptIssuanceId = issuanceId;
    }
    get issuerAddress() {
        return this.wallet.address;
    }
    get issuanceId() {
        if (!this.mptIssuanceId) {
            throw new Error('No MPT issuance attached yet; call createIssuance() first or pass issuanceId to the constructor');
        }
        return this.mptIssuanceId;
    }
    async submit(tx) {
        const response = await this.client.submitAndWait(tx, { wallet: this.wallet });
        if (!response.result.validated) {
            throw new Error(`${tx.TransactionType} was not validated: ${JSON.stringify(response.result)}`);
        }
        const resultCode = extractResultCode(response.result.meta);
        if (resultCode !== 'tesSUCCESS') {
            throw new Error(`${tx.TransactionType} failed with ${resultCode}: ${JSON.stringify(response.result)}`);
        }
        return { submitted: { hash: response.result.hash, resultCode }, response };
    }
    /** Creates the MPT issuance with allowlist, clawback, and lock (freeze) capability enabled. */
    async createIssuance(params = {}) {
        const tx = {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: this.wallet.address,
            Flags: {
                tfMPTRequireAuth: true,
                tfMPTCanLock: true,
                tfMPTCanClawback: true,
                tfMPTCanTransfer: params.allowHolderToHolderTransfers ?? true,
            },
            ...(params.assetScale !== undefined ? { AssetScale: params.assetScale } : {}),
            ...(params.maximumAmount !== undefined ? { MaximumAmount: params.maximumAmount } : {}),
            ...(params.transferFee !== undefined ? { TransferFee: params.transferFee } : {}),
            ...(params.metadata !== undefined ? { MPTokenMetadata: (0, xrpl_1.convertStringToHex)(params.metadata) } : {}),
        };
        const { submitted, response } = await this.submit(tx);
        const meta = response.result.meta;
        const issuanceId = meta == null || typeof meta === 'string' ? undefined : meta.mpt_issuance_id;
        if (!issuanceId) {
            throw new Error('MPTokenIssuanceCreate succeeded but returned no mpt_issuance_id in its metadata');
        }
        this.mptIssuanceId = issuanceId;
        return { issuanceId, ...submitted };
    }
    /**
     * Allowlists a holder who has already opted in (submitted their own
     * MPTokenAuthorize). Required before that holder can send or receive
     * the token, since the issuance requires auth.
     */
    async approveHolder(holderAddress) {
        assertAddress(holderAddress, 'holderAddress');
        const tx = {
            TransactionType: 'MPTokenAuthorize',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holderAddress,
        };
        return (await this.submit(tx)).submitted;
    }
    /**
     * Revokes a previously-approved holder's authorization, without
     * touching their balance. After this, the holder can no longer send or
     * receive the token. Used by banHolder(); exposed directly in case
     * callers need to de-allowlist someone who already holds a zero balance.
     */
    async revokeHolderApproval(holderAddress) {
        assertAddress(holderAddress, 'holderAddress');
        const tx = {
            TransactionType: 'MPTokenAuthorize',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holderAddress,
            Flags: { tfMPTUnauthorize: true },
        };
        return (await this.submit(tx)).submitted;
    }
    /**
     * Sends `value` base units of the token from the issuer to an approved
     * holder.
     *
     * Note on freeze semantics: at the protocol level, an MPT lock (global or
     * per-holder) only blocks transfers *initiated by the holder* to third
     * parties — it does not, by itself, stop the issuer from paying a locked
     * holder directly (the same as classic trust-line freeze, which keeps the
     * issuer/holder relationship open for remediation). Since the compliance
     * requirement here is that a frozen holder can neither send nor receive,
     * this method enforces the "receive" half itself by refusing to send to a
     * holder or issuance that is currently locked.
     */
    async send(destinationAddress, value) {
        assertAddress(destinationAddress, 'destinationAddress');
        assertPositiveIntegerString(value, 'value');
        const issuance = await this.getIssuance();
        if (issuance.globallyLocked) {
            throw new Error('Cannot send: this MPT issuance is globally frozen');
        }
        const holderToken = await this.getHolderMPToken(destinationAddress);
        if (holderToken?.locked) {
            throw new Error(`Cannot send: holder ${destinationAddress} is frozen`);
        }
        const tx = {
            TransactionType: 'Payment',
            Account: this.wallet.address,
            Destination: destinationAddress,
            Amount: { mpt_issuance_id: this.issuanceId, value },
        };
        return (await this.submit(tx)).submitted;
    }
    /** Claws back `value` base units of the token from a holder, regardless of freeze state. */
    async clawback(holderAddress, value) {
        assertAddress(holderAddress, 'holderAddress');
        assertPositiveIntegerString(value, 'value');
        const tx = {
            TransactionType: 'Clawback',
            Account: this.wallet.address,
            Holder: holderAddress,
            Amount: { mpt_issuance_id: this.issuanceId, value },
        };
        return (await this.submit(tx)).submitted;
    }
    /** Freezes a single holder: they can neither send nor receive the token. */
    async freezeHolder(holderAddress) {
        assertAddress(holderAddress, 'holderAddress');
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holderAddress,
            Flags: { tfMPTLock: true },
        };
        return (await this.submit(tx)).submitted;
    }
    /** Lifts a previously-applied per-holder freeze. */
    async unfreezeHolder(holderAddress) {
        assertAddress(holderAddress, 'holderAddress');
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Holder: holderAddress,
            Flags: { tfMPTUnlock: true },
        };
        return (await this.submit(tx)).submitted;
    }
    /** Freezes all movement of the token, for every holder, e.g. during an incident. */
    async globalFreeze() {
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Flags: { tfMPTLock: true },
        };
        return (await this.submit(tx)).submitted;
    }
    /** Lifts a previously-applied global freeze. */
    async globalUnfreeze() {
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.wallet.address,
            MPTokenIssuanceID: this.issuanceId,
            Flags: { tfMPTUnlock: true },
        };
        return (await this.submit(tx)).submitted;
    }
    /**
     * Bans a holder: claws back their entire balance (if any) so they end up
     * holding none of the token, then revokes their authorization so they
     * cannot be paid again while the issuance requires auth. Once the balance
     * is zero, revoking authorization deletes the holder's MPToken object
     * entirely (refunding their reserve) rather than merely clearing a flag,
     * so getHolderMPToken()/getHolderBalance() may report the holder as
     * absent afterward — treat that the same as balance "0" / unauthorized.
     */
    async banHolder(holderAddress) {
        assertAddress(holderAddress, 'holderAddress');
        const balance = await this.getHolderBalance(holderAddress);
        const clawback = balance !== '0' ? await this.clawback(holderAddress, balance) : undefined;
        const revoke = await this.revokeHolderApproval(holderAddress);
        return { holder: holderAddress, clawedBack: balance, clawback, revoke };
    }
    /** Reads the current on-ledger state of the issuance itself. */
    async getIssuance() {
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
            outstandingAmount: node.OutstandingAmount,
            ...(node.MaximumAmount !== undefined ? { maximumAmount: node.MaximumAmount } : {}),
            ...(node.AssetScale !== undefined ? { assetScale: node.AssetScale } : {}),
            ...(node.TransferFee !== undefined ? { transferFee: node.TransferFee } : {}),
            requireAuth: Boolean(flags.lsfMPTRequireAuth),
            canLock: Boolean(flags.lsfMPTCanLock),
            canClawback: Boolean(flags.lsfMPTCanClawback),
            canTransfer: Boolean(flags.lsfMPTCanTransfer),
            globallyLocked: Boolean(flags.lsfMPTLocked),
        };
    }
    /** Reads a specific holder's MPToken object, or null if they have never opted in (or have since deleted it). */
    async getHolderMPToken(holderAddress) {
        assertAddress(holderAddress, 'holderAddress');
        try {
            const response = await this.client.request({
                command: 'ledger_entry',
                mptoken: { mpt_issuance_id: this.issuanceId, account: holderAddress },
                ledger_index: 'validated',
            });
            const node = response.result.node;
            return {
                account: holderAddress,
                issuanceId: this.issuanceId,
                // The ledger omits MPTAmount entirely when the balance is zero.
                balance: node.MPTAmount ?? '0',
                authorized: (node.Flags & MPTOKEN_FLAG_AUTHORIZED) !== 0,
                locked: (node.Flags & MPTOKEN_FLAG_LOCKED) !== 0,
            };
        }
        catch (error) {
            if (isEntryNotFoundError(error)) {
                return null;
            }
            throw error;
        }
    }
    /** Convenience wrapper over getHolderMPToken() that returns "0" instead of null for holders with no MPToken object. */
    async getHolderBalance(holderAddress) {
        const mptoken = await this.getHolderMPToken(holderAddress);
        return mptoken?.balance ?? '0';
    }
}
exports.MptIssuer = MptIssuer;
/**
 * Holder-signed opt-in: creates the holder's MPToken object for this
 * issuance. Must happen before the issuer can approveHolder() them, since
 * MPTokenAuthorize requires the holder's MPToken to already exist.
 */
async function optInHolder(client, holderWallet, issuanceId) {
    const tx = {
        TransactionType: 'MPTokenAuthorize',
        Account: holderWallet.address,
        MPTokenIssuanceID: issuanceId,
    };
    const response = await client.submitAndWait(tx, { wallet: holderWallet });
    if (!response.result.validated) {
        throw new Error(`MPTokenAuthorize (opt-in) was not validated: ${JSON.stringify(response.result)}`);
    }
    const resultCode = extractResultCode(response.result.meta);
    if (resultCode !== 'tesSUCCESS') {
        throw new Error(`MPTokenAuthorize (opt-in) failed with ${resultCode}: ${JSON.stringify(response.result)}`);
    }
    return { hash: response.result.hash, resultCode };
}
//# sourceMappingURL=mptIssuer.js.map