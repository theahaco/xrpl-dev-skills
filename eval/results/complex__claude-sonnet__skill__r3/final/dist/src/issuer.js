"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MptIssuer = void 0;
const xrpl_1 = require("xrpl");
const txSubmit_1 = require("./txSubmit");
const mptFlags_1 = require("./mptFlags");
/**
 * Issuer-side control plane for a single regulated MPT issuance.
 *
 * Every mutating method submits exactly one XRPL transaction (except
 * `banHolder`, which is a clawback-then-revoke compound operation), waits
 * for ledger validation, and throws `TransactionFailedError` on any
 * non-`tesSUCCESS` result. Callers should treat a resolved promise as proof
 * the effect is durably recorded on the ledger.
 */
class MptIssuer {
    constructor(client, issuerWallet) {
        this.client = client;
        this.issuerWallet = issuerWallet;
    }
    get issuerAddress() {
        return this.issuerWallet.address;
    }
    /**
     * Creates the MPT issuance with the full compliance control surface
     * enabled: authorization-gated holding (allowlist), per-holder and
     * global freeze (lock), and clawback. Returns the new issuance ID.
     */
    async createIssuance(params) {
        let flags = xrpl_1.MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
            xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanLock |
            xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanClawback;
        if (params.allowHolderToHolderTransfer ?? true) {
            flags |= xrpl_1.MPTokenIssuanceCreateFlags.tfMPTCanTransfer;
        }
        const response = await (0, txSubmit_1.submitAndVerify)(this.client, this.issuerWallet, {
            TransactionType: "MPTokenIssuanceCreate",
            Account: this.issuerAddress,
            AssetScale: params.assetScale,
            MaximumAmount: params.maximumAmount,
            ...(params.transferFee !== undefined ? { TransferFee: params.transferFee } : {}),
            ...(params.metadata !== undefined
                ? { MPTokenMetadata: (0, xrpl_1.encodeMPTokenMetadata)(params.metadata) }
                : {}),
            Flags: flags,
        });
        const issuanceId = response.result.meta && typeof response.result.meta === "object"
            ? response.result.meta.mpt_issuance_id
            : undefined;
        if (!issuanceId) {
            throw new Error("MPTokenIssuanceCreate succeeded but no mpt_issuance_id was returned");
        }
        return { issuanceId, hash: response.result.hash };
    }
    /**
     * Allowlist: approves a holder who has already opted in (submitted their
     * own `MPTokenAuthorize`). Required before that holder can receive or
     * send the token, since the issuance is created with `tfMPTRequireAuth`.
     */
    async approveHolder(issuanceId, holderAddress) {
        return (0, txSubmit_1.submitAndVerify)(this.client, this.issuerWallet, {
            TransactionType: "MPTokenAuthorize",
            Account: this.issuerAddress,
            MPTokenIssuanceID: issuanceId,
            Holder: holderAddress,
        });
    }
    /** Sends `value` (in display units) of the token from the issuer to a holder. */
    async sendTokens(issuanceId, holderAddress, value) {
        return (0, txSubmit_1.submitAndVerify)(this.client, this.issuerWallet, {
            TransactionType: "Payment",
            Account: this.issuerAddress,
            Destination: holderAddress,
            Amount: { mpt_issuance_id: issuanceId, value },
        });
    }
    /** Claws back `value` (in display units) of the token from a holder, back to the issuer. */
    async clawback(issuanceId, holderAddress, value) {
        return (0, txSubmit_1.submitAndVerify)(this.client, this.issuerWallet, {
            TransactionType: "Clawback",
            Account: this.issuerAddress,
            Holder: holderAddress,
            Amount: { mpt_issuance_id: issuanceId, value },
        });
    }
    /**
     * Per-holder freeze: blocks this holder from sending or receiving the
     * token to or from any other holder. The issuer itself remains an exempt
     * counterparty (as with classic trust-line freezes) so that `clawback`
     * and issuer-initiated payments keep working on a frozen account.
     */
    async freezeHolder(issuanceId, holderAddress) {
        return (0, txSubmit_1.submitAndVerify)(this.client, this.issuerWallet, {
            TransactionType: "MPTokenIssuanceSet",
            Account: this.issuerAddress,
            MPTokenIssuanceID: issuanceId,
            Holder: holderAddress,
            Flags: xrpl_1.MPTokenIssuanceSetFlags.tfMPTLock,
        });
    }
    /** Lifts a per-holder freeze. */
    async unfreezeHolder(issuanceId, holderAddress) {
        return (0, txSubmit_1.submitAndVerify)(this.client, this.issuerWallet, {
            TransactionType: "MPTokenIssuanceSet",
            Account: this.issuerAddress,
            MPTokenIssuanceID: issuanceId,
            Holder: holderAddress,
            Flags: xrpl_1.MPTokenIssuanceSetFlags.tfMPTUnlock,
        });
    }
    /**
     * Global freeze: blocks movement of the token between any two holders,
     * for the whole issuance at once (e.g. during an incident). As with
     * `freezeHolder`, the issuer remains an exempt counterparty, so this does
     * not prevent the issuer from still running `clawback` or administrative
     * payments while the freeze is in effect.
     */
    async globalFreeze(issuanceId) {
        return (0, txSubmit_1.submitAndVerify)(this.client, this.issuerWallet, {
            TransactionType: "MPTokenIssuanceSet",
            Account: this.issuerAddress,
            MPTokenIssuanceID: issuanceId,
            Flags: xrpl_1.MPTokenIssuanceSetFlags.tfMPTLock,
        });
    }
    /** Lifts a global freeze. */
    async globalUnfreeze(issuanceId) {
        return (0, txSubmit_1.submitAndVerify)(this.client, this.issuerWallet, {
            TransactionType: "MPTokenIssuanceSet",
            Account: this.issuerAddress,
            MPTokenIssuanceID: issuanceId,
            Flags: xrpl_1.MPTokenIssuanceSetFlags.tfMPTUnlock,
        });
    }
    /**
     * Bans a holder: claws back their entire balance (if any) so they end up
     * holding none of the token, then revokes their authorization so they
     * cannot be paid again while the issuance requires authorization. This is
     * NOT the same as a freeze — authorization revocation is not reversible
     * via `unfreezeHolder`; a banned holder would need to be re-approved via
     * `approveHolder` to ever hold the token again.
     */
    async banHolder(issuanceId, holderAddress) {
        const results = [];
        const holderState = await this.getHolder(issuanceId, holderAddress);
        if (holderState && BigInt(holderState.balance) > 0n) {
            results.push(await this.clawback(issuanceId, holderAddress, holderState.balance));
        }
        results.push(await (0, txSubmit_1.submitAndVerify)(this.client, this.issuerWallet, {
            TransactionType: "MPTokenAuthorize",
            Account: this.issuerAddress,
            MPTokenIssuanceID: issuanceId,
            Holder: holderAddress,
            Flags: xrpl_1.MPTokenAuthorizeFlags.tfMPTUnauthorize,
        }));
        return results;
    }
    /** Reads the issuance's current supply and compliance-flag state. */
    async getIssuance(issuanceId) {
        const response = await this.client.request({
            command: "ledger_entry",
            mpt_issuance: issuanceId,
            ledger_index: "validated",
        });
        const node = response.result.node;
        if (node.LedgerEntryType !== "MPTokenIssuance") {
            throw new Error(`Expected an MPTokenIssuance ledger entry, got ${node.LedgerEntryType}`);
        }
        const flags = (0, xrpl_1.parseMPTokenIssuanceFlags)(node.Flags);
        return {
            issuanceId,
            issuer: node.Issuer,
            outstandingAmount: node.OutstandingAmount,
            maximumAmount: node.MaximumAmount,
            assetScale: node.AssetScale,
            transferFee: node.TransferFee,
            globallyLocked: flags.lsfMPTLocked ?? false,
            requireAuth: flags.lsfMPTRequireAuth ?? false,
            canClawback: flags.lsfMPTCanClawback ?? false,
            canLock: flags.lsfMPTCanLock ?? false,
        };
    }
    /** Reads a holder's balance, authorization, and freeze state. Returns
     * `null` if the holder has never opted in (no MPToken object exists). */
    async getHolder(issuanceId, holderAddress) {
        try {
            const response = await this.client.request({
                command: "ledger_entry",
                mptoken: { mpt_issuance_id: issuanceId, account: holderAddress },
                ledger_index: "validated",
            });
            // The xrpl.js `LedgerEntry` union type omits `MPToken` (a gap in the
            // SDK's type definitions as of v5.3.0), so we narrow through
            // `unknown` and verify the discriminant at runtime instead.
            const node = response.result.node;
            if (node.LedgerEntryType !== "MPToken") {
                throw new Error(`Expected an MPToken ledger entry, got ${node.LedgerEntryType}`);
            }
            return {
                issuanceId,
                holder: holderAddress,
                balance: node.MPTAmount ?? "0",
                authorized: (0, mptFlags_1.hasFlag)(node.Flags, mptFlags_1.MPTokenFlags.lsfMPTAuthorized),
                locked: (0, mptFlags_1.hasFlag)(node.Flags, mptFlags_1.MPTokenFlags.lsfMPTLocked),
            };
        }
        catch (error) {
            if (error instanceof Error && "data" in error) {
                const data = error.data;
                if (data?.error === "entryNotFound") {
                    return null;
                }
            }
            throw error;
        }
    }
}
exports.MptIssuer = MptIssuer;
//# sourceMappingURL=issuer.js.map