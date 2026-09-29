"use strict";
/**
 * Issuer-side controls for a regulated Multi-Purpose Token (MPT) on the XRP Ledger.
 *
 * The issuance is created with:
 *   - tfMPTRequireAuth  -> allowlist: only issuer-approved holders can hold the token
 *   - tfMPTCanLock      -> per-holder and global freeze
 *   - tfMPTCanClawback  -> issuer can claw back tokens from any holder
 *   - tfMPTCanTransfer  -> the token can move between non-issuer accounts
 *
 * "Ban" is not a native MPT primitive. It is implemented here as the composition of the
 * three primitives above: sweep the holder's balance to zero (Clawback), lock their
 * MPToken so it can't move (MPTokenIssuanceSet + Holder), and revoke their allowlist
 * authorization (MPTokenAuthorize + tfMPTUnauthorize) so RequireAuth blocks any future
 * incoming payment. A banned holder is also recorded so this module refuses to
 * re-approve them later, even though nothing here would resurrect the address on its own.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MptIssuer = exports.HolderBannedError = exports.MptTransactionError = void 0;
exports.optInToMpt = optInToMpt;
exports.submitAndAssertSuccess = submitAndAssertSuccess;
const xrpl_1 = require("xrpl");
function holderAddress(holder) {
    return typeof holder === 'string' ? holder : holder.address;
}
const MPT_ISSUANCE_LOCKED = 0x00000001; // lsfMPTLocked on MPTokenIssuance
const MPT_ISSUANCE_REQUIRE_AUTH = 0x00000004; // lsfMPTRequireAuth
const MPT_ISSUANCE_CAN_CLAWBACK = 0x00000040; // lsfMPTCanClawback
const MPT_ISSUANCE_CAN_LOCK = 0x00000002; // lsfMPTCanLock
const MPT_ISSUANCE_CAN_TRANSFER = 0x00000020; // lsfMPTCanTransfer
const MPTOKEN_LOCKED = 0x00000001; // lsfMPTLocked on MPToken
const MPTOKEN_AUTHORIZED = 0x00000002; // lsfMPTAuthorized on MPToken
function hasFlag(flags, bit) {
    return (flags & bit) === bit;
}
function utf8ToHex(value) {
    return Buffer.from(value, 'utf8').toString('hex').toUpperCase();
}
/** Thrown when a submitted transaction lands on-ledger but does not succeed (non-tes* result). */
class MptTransactionError extends Error {
    constructor(transactionType, transactionResult, txHash) {
        super(`${transactionType} failed with ${transactionResult}${txHash ? ` (tx ${txHash})` : ''}`);
        this.transactionType = transactionType;
        this.transactionResult = transactionResult;
        this.txHash = txHash;
        this.name = 'MptTransactionError';
    }
}
exports.MptTransactionError = MptTransactionError;
/** Thrown when trying to approve a holder this module has previously banned. */
class HolderBannedError extends Error {
    constructor(holder) {
        super(`Holder ${holder} has been banned and cannot be re-approved by this module instance`);
        this.holder = holder;
        this.name = 'HolderBannedError';
    }
}
exports.HolderBannedError = HolderBannedError;
class MptIssuer {
    constructor(client, issuer) {
        this.client = client;
        this.issuer = issuer;
        this.bannedHolders = new Set();
    }
    get issuerAddress() {
        return this.issuer.address;
    }
    /** Signs and submits a transaction from the issuer's wallet, waits for validation, and throws unless it succeeded. */
    async submitAsIssuer(tx) {
        return submitAndAssertSuccess(this.client, this.issuer, tx);
    }
    // ---------------------------------------------------------------------
    // Issuance lifecycle
    // ---------------------------------------------------------------------
    /** Creates the MPT issuance with allowlist, freeze, and clawback all enabled. Returns the new issuance ID. */
    async createIssuance(options = {}) {
        const metadataHex = options.metadata === undefined
            ? undefined
            : typeof options.metadata === 'string'
                ? options.metadata
                : utf8ToHex(JSON.stringify(options.metadata));
        const tx = {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: this.issuer.address,
            AssetScale: options.assetScale ?? 0,
            ...(options.maximumAmount !== undefined ? { MaximumAmount: options.maximumAmount } : {}),
            ...(options.transferFee !== undefined ? { TransferFee: options.transferFee } : {}),
            ...(metadataHex !== undefined ? { MPTokenMetadata: metadataHex } : {}),
            Flags: xrpl_1.MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
                xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanLock |
                xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanClawback |
                xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
        };
        const response = await this.submitAsIssuer(tx);
        const meta = response.result.meta;
        const issuanceId = meta && typeof meta === 'object' && 'mpt_issuance_id' in meta
            ? meta.mpt_issuance_id
            : undefined;
        if (!issuanceId) {
            throw new Error('MPTokenIssuanceCreate succeeded but no mpt_issuance_id was returned');
        }
        return issuanceId;
    }
    // ---------------------------------------------------------------------
    // Allowlist (KYC gate)
    // ---------------------------------------------------------------------
    /**
     * Approves a holder who has already opted in (see `optInToMpt`) to hold this MPT.
     * Call this only after your KYC process has cleared the holder.
     */
    async approveHolder(holder, issuanceId) {
        const address = holderAddress(holder);
        if (this.bannedHolders.has(address)) {
            throw new HolderBannedError(address);
        }
        const tx = {
            TransactionType: 'MPTokenAuthorize',
            Account: this.issuer.address,
            MPTokenIssuanceID: issuanceId,
            Holder: address,
        };
        await this.submitAsIssuer(tx);
    }
    /** Revokes a holder's allowlist authorization without touching their balance or lock state. */
    async revokeHolderAuthorization(holder, issuanceId) {
        const tx = {
            TransactionType: 'MPTokenAuthorize',
            Account: this.issuer.address,
            MPTokenIssuanceID: issuanceId,
            Holder: holderAddress(holder),
            Flags: xrpl_1.MPTokenAuthorizeFlags.tfMPTUnauthorize,
        };
        await this.submitAsIssuer(tx);
    }
    // ---------------------------------------------------------------------
    // Payments
    // ---------------------------------------------------------------------
    /** Sends `value` base units of the MPT from the issuer to an approved holder. */
    async sendFromIssuer(to, issuanceId, value) {
        const tx = {
            TransactionType: 'Payment',
            Account: this.issuer.address,
            Destination: holderAddress(to),
            Amount: { mpt_issuance_id: issuanceId, value },
        };
        await this.submitAsIssuer(tx);
    }
    // ---------------------------------------------------------------------
    // Clawback
    // ---------------------------------------------------------------------
    /** Claws back `value` base units of the MPT from a holder. If it exceeds their balance, the whole balance is taken. */
    async clawback(holder, issuanceId, value) {
        const tx = {
            TransactionType: 'Clawback',
            Account: this.issuer.address,
            Holder: holderAddress(holder),
            Amount: { mpt_issuance_id: issuanceId, value },
        };
        await this.submitAsIssuer(tx);
    }
    /** Claws back a holder's entire current balance. No-ops if they hold none (or never opted in). */
    async clawbackAll(holder, issuanceId) {
        const address = holderAddress(holder);
        const state = await this.getHolderState(address, issuanceId);
        if (!state.exists || state.balance === '0') {
            return;
        }
        await this.clawback(address, issuanceId, state.balance);
    }
    // ---------------------------------------------------------------------
    // Per-holder freeze
    // ---------------------------------------------------------------------
    async freezeHolder(holder, issuanceId) {
        await this.setLock(issuanceId, xrpl_1.MPTokenIssuanceSetFlags.tfMPTLock, holderAddress(holder));
    }
    async unfreezeHolder(holder, issuanceId) {
        await this.setLock(issuanceId, xrpl_1.MPTokenIssuanceSetFlags.tfMPTUnlock, holderAddress(holder));
    }
    // ---------------------------------------------------------------------
    // Global freeze
    // ---------------------------------------------------------------------
    async freezeGlobal(issuanceId) {
        await this.setLock(issuanceId, xrpl_1.MPTokenIssuanceSetFlags.tfMPTLock);
    }
    async unfreezeGlobal(issuanceId) {
        await this.setLock(issuanceId, xrpl_1.MPTokenIssuanceSetFlags.tfMPTUnlock);
    }
    async setLock(issuanceId, flag, holder) {
        const tx = {
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.issuer.address,
            MPTokenIssuanceID: issuanceId,
            Flags: flag,
            ...(holder !== undefined ? { Holder: holder } : {}),
        };
        await this.submitAsIssuer(tx);
    }
    // ---------------------------------------------------------------------
    // Ban: hold none, and can never receive again
    // ---------------------------------------------------------------------
    /**
     * Bans a holder: sweeps their balance to zero, locks their MPToken so it cannot move,
     * and revokes their allowlist authorization so they cannot be paid again while
     * RequireAuth is enforced. The holder is also remembered so `approveHolder` refuses
     * to re-admit them later via this module instance.
     *
     * In a production deployment, back this module's banned-holder set with persistent
     * storage (e.g. a database row per holder) rather than the in-memory Set used here,
     * so the ban survives a process restart.
     */
    async banHolder(holder, issuanceId) {
        const address = holderAddress(holder);
        await this.clawbackAll(address, issuanceId);
        const state = await this.getHolderState(address, issuanceId);
        if (state.exists && !state.locked) {
            await this.freezeHolder(address, issuanceId);
        }
        if (state.exists && state.authorized) {
            await this.revokeHolderAuthorization(address, issuanceId);
        }
        this.bannedHolders.add(address);
    }
    isBanned(holder) {
        return this.bannedHolders.has(holderAddress(holder));
    }
    // ---------------------------------------------------------------------
    // Read-side helpers (useful for compliance reporting/audits)
    // ---------------------------------------------------------------------
    async getIssuanceState(issuanceId) {
        const entry = await this.findLedgerEntry(this.issuer.address, 'mpt_issuance', (obj) => obj.mpt_issuance_id === issuanceId || true);
        if (!entry) {
            throw new Error(`MPTokenIssuance ${issuanceId} not found under issuer ${this.issuer.address}`);
        }
        return {
            issuanceId,
            issuer: entry.Issuer,
            outstandingAmount: entry.OutstandingAmount,
            maximumAmount: entry.MaximumAmount,
            globallyLocked: hasFlag(entry.Flags, MPT_ISSUANCE_LOCKED),
            requireAuth: hasFlag(entry.Flags, MPT_ISSUANCE_REQUIRE_AUTH),
            canClawback: hasFlag(entry.Flags, MPT_ISSUANCE_CAN_CLAWBACK),
            canLock: hasFlag(entry.Flags, MPT_ISSUANCE_CAN_LOCK),
            canTransfer: hasFlag(entry.Flags, MPT_ISSUANCE_CAN_TRANSFER),
        };
    }
    async getHolderState(holder, issuanceId) {
        const address = holderAddress(holder);
        const entry = await this.findLedgerEntry(address, 'mptoken', (obj) => obj.MPTokenIssuanceID === issuanceId);
        if (!entry) {
            return { holder: address, issuanceId, exists: false, balance: '0', authorized: false, locked: false };
        }
        return {
            holder: address,
            issuanceId,
            exists: true,
            balance: entry.MPTAmount ?? '0',
            authorized: hasFlag(entry.Flags, MPTOKEN_AUTHORIZED),
            locked: hasFlag(entry.Flags, MPTOKEN_LOCKED),
        };
    }
    async findLedgerEntry(account, type, predicate) {
        const response = await this.client.request({
            command: 'account_objects',
            account,
            type,
            ledger_index: 'validated',
        });
        const objects = response.result.account_objects;
        return objects.find(predicate);
    }
}
exports.MptIssuer = MptIssuer;
// ---------------------------------------------------------------------
// Holder-side helper
// ---------------------------------------------------------------------
/**
 * Opts a holder in to an MPT issuance. This must be signed by the holder themselves
 * (self-custody) before the issuer can approve them with `MptIssuer.approveHolder`.
 */
async function optInToMpt(client, holder, issuanceId) {
    const tx = {
        TransactionType: 'MPTokenAuthorize',
        Account: holder.address,
        MPTokenIssuanceID: issuanceId,
    };
    await submitAndAssertSuccess(client, holder, tx);
}
// ---------------------------------------------------------------------
// Shared submit helper
// ---------------------------------------------------------------------
async function submitAndAssertSuccess(client, wallet, tx) {
    const prepared = await client.autofill(tx);
    const signed = wallet.sign(prepared);
    const response = await client.submitAndWait(signed.tx_blob);
    const meta = response.result.meta;
    const transactionResult = meta && typeof meta === 'object' && 'TransactionResult' in meta
        ? meta.TransactionResult
        : undefined;
    if (transactionResult !== 'tesSUCCESS') {
        throw new MptTransactionError(tx.TransactionType, transactionResult ?? 'UNKNOWN', response.result.hash);
    }
    return response;
}
//# sourceMappingURL=mptIssuer.js.map