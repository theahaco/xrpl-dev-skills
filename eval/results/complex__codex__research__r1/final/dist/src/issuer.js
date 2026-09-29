import { AccountSetAsfFlags, Client, encodeMPTokenMetadata, isValidClassicAddress, MPTokenAuthorizeFlags, MPTokenIssuanceCreateFlags, MPTokenIssuanceSetFlags, validateMPTokenMetadata } from 'xrpl';
import { Transactions, isRpcError } from './transactions.js';
import {} from './store.js';
export const MAX_AMOUNT = '9223372036854775807';
export const CAPABILITIES = MPTokenIssuanceCreateFlags.tfMPTCanLock |
    MPTokenIssuanceCreateFlags.tfMPTRequireAuth | MPTokenIssuanceCreateFlags.tfMPTCanTransfer |
    MPTokenIssuanceCreateFlags.tfMPTCanClawback;
export const LOCKED = 1;
export const AUTHORIZED = 2;
/** Amounts are integer base units, never floating point. This issuance uses AssetScale=0. */
export function amount(value) {
    if (!/^[1-9][0-9]*$/.test(value) || value.length > 19 || BigInt(value) > BigInt(MAX_AMOUNT))
        throw new Error('Amount must be a positive canonical integer <= 2^63-1');
    return value;
}
export function holderAddress(value, issuer) {
    if (!isValidClassicAddress(value) || value === issuer)
        throw new Error('Expected a holder classic address, distinct from issuer');
    return value;
}
export function issuanceId(value) {
    if (!/^[0-9A-F]{48}$/.test(value))
        throw new Error('Expected a 192-bit uppercase MPT issuance ID');
    return value;
}
export async function preflight(client) {
    const [server, features] = await Promise.all([
        client.request({ command: 'server_info' }), client.request({ command: 'feature' }),
    ]);
    if (server.result.info.network_id !== 1)
        throw new Error('Expected testnet network_id 1');
    const enabled = Object.values(features.result.features ?? {}).filter(f => f.enabled).map(f => f.name);
    for (const name of ['MPTokensV1', 'Clawback', 'DepositAuth', 'DepositPreauth'])
        if (!enabled.includes(name))
            throw new Error(`Missing amendment: ${name}`);
    return { checkedAt: new Date().toISOString(), server: server.result, features: features.result };
}
/** Account-wide restriction: block direct redemption, including the native MPT lock exception.
 * No account or credential DepositPreauth entries are permitted for this dedicated issuer.
 */
export async function requireRedemptionGuard(client, issuer, ledger = 'validated') {
    const info = await client.request({ command: 'account_info', account: issuer, ledger_index: ledger });
    if (!info.result.validated || !(info.result.account_data.Flags & 0x01000000))
        throw new Error('Issuer DepositAuth is required to block direct redemption during freezes');
    let marker;
    do {
        const page = await client.request({ command: 'account_objects', account: issuer, type: 'deposit_preauth',
            ledger_index: info.result.ledger_index, ...(marker ? { marker } : {}) });
        if (!page.result.validated || page.result.account_objects.length)
            throw new Error('Issuer must have no DepositPreauth entries');
        marker = page.result.marker;
    } while (marker);
    return info.result.account_data;
}
export async function readHolding(client, id, holder, ledger = 'validated') {
    try {
        const response = await client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: issuanceId(id), account: holder }, ledger_index: ledger });
        if (!response.result.validated || response.result.node?.LedgerEntryType !== 'MPToken')
            throw new Error('Invalid/unvalidated holder entry');
        // rippled can omit a default zero balance even though xrpl's interface marks it required.
        return { ...response.result.node, MPTAmount: response.result.node.MPTAmount ?? '0' };
    }
    catch (error) {
        if (isRpcError(error, 'entryNotFound'))
            return undefined;
        throw error;
    }
}
export async function readIssuance(client, id, ledger = 'validated') {
    const response = await client.request({ command: 'ledger_entry', mpt_issuance: issuanceId(id), ledger_index: ledger });
    if (!response.result.validated || response.result.node.LedgerEntryType !== 'MPTokenIssuance')
        throw new Error('Invalid/unvalidated issuance entry');
    return { ...response.result.node, OutstandingAmount: response.result.node.OutstandingAmount ?? '0' };
}
/** Backend issuer API. The caller is responsible for KYC decisions and access control.
 * DepositAuth closes the holder redemption exception; issue() closes issuer mint exceptions.
 * Unrestricted issuer signing can always bypass policy. Use a dedicated issuer exclusively via this API.
 * Each mutating call needs a unique, durable business operation ID.
 */
export class MptIssuer {
    id;
    tx;
    signer;
    constructor(id, tx, signer) {
        this.id = id;
        this.tx = tx;
        this.signer = signer;
    }
    static async configureIssuer(tx, signer, operationId) {
        if (tx.store.state.issuer !== signer.classicAddress)
            throw new Error('Store signer mismatch');
        await preflight(tx.client);
        await tx.send(operationId, { TransactionType: 'AccountSet', Account: signer.classicAddress, SetFlag: AccountSetAsfFlags.asfDepositAuth }, signer);
        await requireRedemptionGuard(tx.client, signer.classicAddress);
    }
    static async create(tx, signer, operationId, metadata) {
        if (tx.store.state.issuer !== signer.classicAddress)
            throw new Error('Store signer mismatch');
        await preflight(tx.client);
        await requireRedemptionGuard(tx.client, signer.classicAddress);
        const encoded = metadata ? encodeMPTokenMetadata(metadata) : undefined;
        if (encoded && validateMPTokenMetadata(encoded).length)
            throw new Error('Metadata must conform to XLS-89');
        const receipt = await tx.send(operationId, {
            TransactionType: 'MPTokenIssuanceCreate', Account: signer.classicAddress,
            AssetScale: 0, MaximumAmount: MAX_AMOUNT, TransferFee: 0, Flags: CAPABILITIES,
            ...(encoded ? { MPTokenMetadata: encoded } : {}),
        }, signer);
        if (!receipt.issuanceId)
            throw new Error(`Missing mpt_issuance_id in validated metadata: ${receipt.hash}`);
        tx.store.state.issuanceId = receipt.issuanceId;
        tx.store.save();
        return MptIssuer.attach(tx, signer, receipt.issuanceId);
    }
    static async attach(tx, signer, id) {
        issuanceId(id);
        if (tx.store.state.issuer !== signer.classicAddress)
            throw new Error('Store signer mismatch');
        await preflight(tx.client);
        await requireRedemptionGuard(tx.client, signer.classicAddress);
        const entry = await readIssuance(tx.client, id);
        // Reject unsupported escrow/trading/confidential/domain configurations: ban must reach the whole balance.
        if (entry.Issuer !== signer.classicAddress || (entry.Flags & ~LOCKED) !== CAPABILITIES ||
            entry.DomainID || (entry.AssetScale ?? 0) !== 0 || (entry.TransferFee ?? 0) !== 0)
            throw new Error('Issuance does not match the compliance profile');
        return new MptIssuer(id, tx, signer);
    }
    serial(fn) {
        return this.tx.exclusive(async () => { await requireRedemptionGuard(this.tx.client, this.signer.classicAddress); return fn(); });
    }
    holder(value) { return holderAddress(value, this.signer.classicAddress); }
    banKey(holder) { return `${this.id}:${holder}`; }
    ensureNotBanned(holder) {
        if (this.tx.store.state.bans[this.banKey(holder)])
            throw new Error('Address is permanently banned by issuer policy');
    }
    /** Holder signs this separately; issuer approval alone does not create the holder entry. */
    optInTransaction(holder) {
        return { TransactionType: 'MPTokenAuthorize', Account: this.holder(holder), MPTokenIssuanceID: this.id };
    }
    approve(holder, operationId) {
        return this.serial(async () => {
            this.holder(holder);
            this.ensureNotBanned(holder);
            return this.tx.send(operationId, { TransactionType: 'MPTokenAuthorize', Account: this.signer.classicAddress,
                MPTokenIssuanceID: this.id, Holder: holder }, this.signer, async () => {
                if (!await readHolding(this.tx.client, this.id, holder))
                    throw new Error('Holder must opt in before approval');
            });
        });
    }
    issue(holder, value, operationId) {
        return this.serial(async () => {
            this.holder(holder);
            this.ensureNotBanned(holder);
            amount(value);
            return this.tx.send(operationId, { TransactionType: 'Payment', Account: this.signer.classicAddress,
                Destination: holder, Amount: { mpt_issuance_id: this.id, value } }, this.signer, async () => {
                const [holding, issuance] = await Promise.all([readHolding(this.tx.client, this.id, holder), readIssuance(this.tx.client, this.id)]);
                if (!holding || !(holding.Flags & AUTHORIZED) || (holding.Flags & LOCKED) || (issuance.Flags & LOCKED))
                    throw new Error('Issuance requires an approved, unlocked holder and unlocked issuance');
            });
        });
    }
    clawback(holder, value, operationId) {
        return this.serial(() => this.clawbackInternal(this.holder(holder), amount(value), operationId));
    }
    clawbackInternal(holder, value, operationId) {
        return this.tx.send(operationId, { TransactionType: 'Clawback', Account: this.signer.classicAddress,
            Holder: holder, Amount: { mpt_issuance_id: this.id, value } }, this.signer);
    }
    /** Lock plus issuer DepositAuth blocks holder-initiated movements. */
    freezeHolder(holder, frozen, operationId) {
        return this.serial(async () => {
            this.holder(holder);
            if (!frozen)
                this.ensureNotBanned(holder);
            return this.tx.send(operationId, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.classicAddress,
                MPTokenIssuanceID: this.id, Holder: holder,
                Flags: frozen ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock }, this.signer);
        });
    }
    freezeGlobal(frozen, operationId) {
        return this.serial(() => this.tx.send(operationId, { TransactionType: 'MPTokenIssuanceSet',
            Account: this.signer.classicAddress, MPTokenIssuanceID: this.id,
            Flags: frozen ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock }, this.signer));
    }
    /** Resumable saga: persist ban -> revoke authorization -> drain -> verify.
     * No unban API. A holder can delete/recreate an empty entry, but cannot restore issuer authorization.
     * Only reports success after validated zero balance and revoked authorization.
     */
    ban(holder, reason, operationId) {
        return this.serial(async () => {
            this.holder(holder);
            if (!reason.trim() || reason.length > 500)
                throw new Error('A nonempty ban reason (<=500 characters) is required');
            const key = this.banKey(holder);
            const ban = this.tx.store.state.bans[key] ??= { reason, requestedAt: new Date().toISOString(), completed: false };
            this.tx.store.save(); // Fail closed for subsequent approval, mint and unlock calls, even after a crash.
            const unrelatedPending = Object.entries(this.tx.store.state.transactions).find(([id, entry]) => !entry.receipt && id !== `${operationId}/revoke` && id !== `${operationId}/drain`);
            if (unrelatedPending)
                throw new Error(`Resolve pending operation ${unrelatedPending[0]} before completing ban`);
            const revokeId = `${operationId}/revoke`;
            if (await readHolding(this.tx.client, this.id, holder) || this.tx.store.state.transactions[revokeId]) {
                await this.tx.send(revokeId, { TransactionType: 'MPTokenAuthorize', Account: this.signer.classicAddress,
                    MPTokenIssuanceID: this.id, Holder: holder, Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize }, this.signer);
            }
            const drainId = `${operationId}/drain`;
            const holding = await readHolding(this.tx.client, this.id, holder);
            if (BigInt(holding?.MPTAmount ?? '0') > 0n || this.tx.store.state.transactions[drainId]) {
                // Saturating clawback handles balance changes between observation and validation.
                try {
                    await this.clawbackInternal(holder, MAX_AMOUNT, drainId);
                }
                catch (error) {
                    // A holder may redeem concurrently. Accept tecNO_LINE only after proving zero below.
                    if (!(error instanceof Error) || !('receipt' in error) ||
                        typeof error.receipt !== 'object' || error.receipt === null || !('code' in error.receipt) || error.receipt.code !== 'tecNO_LINE')
                        throw error;
                }
            }
            const final = await readHolding(this.tx.client, this.id, holder);
            if (BigInt(final?.MPTAmount ?? '0') !== 0n || ((final?.Flags ?? 0) & AUTHORIZED))
                throw new Error('Ban incomplete: balance or authorization remains');
            ban.completed = true;
            this.tx.store.save();
        });
    }
}
