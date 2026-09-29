import { MPTokenIssuanceCreateFlags as CreateFlags, MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags as AuthFlags, isValidClassicAddress, encodeMPTokenMetadata, } from 'xrpl';
export const MAX_MPT = '9223372036854775807';
export const ISSUANCE_FLAGS = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
    CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export function amount(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_MPT))
        throw new Error('Amount must be a positive canonical integer string <= 2^63-1');
    return value;
}
export function address(value) {
    if (!isValidClassicAddress(value))
        throw new Error('Invalid classic address');
    return value;
}
export function issuanceId(value) {
    if (!/^[A-F0-9]{48}$/.test(value))
        throw new Error('Invalid MPT issuance ID');
    return value;
}
export function payment(account, destination, id, value) {
    return { TransactionType: 'Payment', Account: address(account), Destination: address(destination),
        Amount: { mpt_issuance_id: issuanceId(id), value: amount(value) } };
}
export async function readIssuance(client, id, ledger = 'validated') {
    const result = await client.request({ command: 'ledger_entry', mpt_issuance: issuanceId(id), ledger_index: ledger });
    if (result.result.validated !== true || result.result.node?.LedgerEntryType !== 'MPTokenIssuance')
        throw new Error('Invalid issuance response');
    const node = result.result.node;
    return { ...node, OutstandingAmount: node.OutstandingAmount ?? '0' };
}
export async function readHolder(client, id, holder, ledger = 'validated') {
    try {
        const result = await client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: issuanceId(id), account: address(holder) }, ledger_index: ledger });
        if (result.result.validated !== true || result.result.node?.LedgerEntryType !== 'MPToken')
            throw new Error('Invalid holder response');
        // rippled omits default-valued fields, including a zero MPTAmount.
        // xrpl 5.3.0 incorrectly models this field as always present.
        const node = result.result.node;
        const balance = node.MPTAmount ?? '0';
        if (!/^(0|[1-9][0-9]*)$/.test(balance) || BigInt(balance) > BigInt(MAX_MPT))
            throw new Error('Invalid holder balance');
        return { ...node, MPTAmount: balance };
    }
    catch (error) {
        if (typeof error === 'object' && error && 'data' in error && typeof error.data === 'object' && error.data && 'error' in error.data && error.data.error === 'entryNotFound')
            return undefined;
        throw error;
    }
}
/** Issuer-only service. Native MPT locks allow issuer interactions; see README. */
export class MptIssuer {
    id;
    signer;
    runner;
    store;
    control(work) { return this.runner.control(this.signer.classicAddress, work); }
    constructor(id, signer, runner, store) {
        this.id = id;
        this.signer = signer;
        this.runner = runner;
        this.store = store;
    }
    static async create(signer, runner, store, operationId) {
        const receipt = await runner.send(operationId, {
            TransactionType: 'MPTokenIssuanceCreate', Account: signer.classicAddress,
            Flags: ISSUANCE_FLAGS, AssetScale: 0, MaximumAmount: '1000000000', TransferFee: 0,
            MPTokenMetadata: encodeMPTokenMetadata({ ticker: 'RTEST', name: 'Regulated test token', desc: 'Testnet compliance demonstration; no monetary value', asset_class: 'other', icon: 'https://xrpl.org/favicon.ico', issuer_name: 'Testnet demo issuer' }),
        }, signer);
        const id = 'mpt_issuance_id' in receipt.meta ? receipt.meta.mpt_issuance_id : undefined;
        if (typeof id !== 'string')
            throw new Error(`Missing issuance ID in metadata for ${receipt.hash}`);
        return MptIssuer.open(id, signer, runner, store);
    }
    static async open(id, signer, runner, store) {
        if (runner.store !== store)
            throw new Error('Issuer policy and transaction journal must use the same Store');
        const entry = await readIssuance(runner.client, id);
        if (entry.Issuer !== signer.classicAddress || (entry.Flags & ISSUANCE_FLAGS) !== ISSUANCE_FLAGS ||
            (entry.Flags & ~(ISSUANCE_FLAGS | 1)) !== 0 || entry.DomainID || (entry.AssetScale ?? 0) !== 0 || (entry.TransferFee ?? 0) !== 0) {
            throw new Error('Issuance does not match the required issuer/compliance profile');
        }
        return new MptIssuer(id, signer, runner, store);
    }
    holder(value) {
        address(value);
        if (value === this.signer.classicAddress)
            throw new Error('Issuer cannot be a holder');
        return value;
    }
    banKey(holder) { return `ban:${this.id}:${holder}`; }
    assertNotBanned(holder) {
        if (this.store.get(this.banKey(holder)))
            throw new Error('Address is permanently banned by issuer policy');
    }
    approve(holder, kyc, operationId) {
        return this.control(async () => {
            this.holder(holder);
            this.assertNotBanned(holder);
            if (!kyc.reference.trim() || !kyc.approvedBy.trim())
                throw new Error('KYC approval reference and reviewer required');
            if (!await readHolder(this.runner.client, this.id, holder))
                throw new Error('Holder must opt in first');
            this.store.put(`kyc:${this.id}:${holder}`, kyc);
            return this.authorize(holder, false, operationId);
        });
    }
    issue(holder, value, operationId) {
        return this.control(async () => {
            this.holder(holder);
            this.assertNotBanned(holder);
            amount(value);
            const [token, issuance] = await Promise.all([readHolder(this.runner.client, this.id, holder), readIssuance(this.runner.client, this.id)]);
            if (!token || !(token.Flags & 2) || (token.Flags & 1) || (issuance.Flags & 1))
                throw new Error('Holder is unauthorized or token is frozen');
            return this.runner.send(operationId, payment(this.signer.classicAddress, holder, this.id, value), this.signer);
        });
    }
    clawback(holder, value, operationId) {
        return this.control(() => this.claw(this.holder(holder), amount(value), operationId));
    }
    freezeHolder(holder, frozen, operationId) {
        return this.control(async () => {
            this.holder(holder);
            if (!frozen)
                this.assertNotBanned(holder);
            return this.lock(frozen, operationId, holder);
        });
    }
    freezeGlobal(frozen, operationId) {
        return this.control(() => this.lock(frozen, operationId));
    }
    /** Durable tombstone first; revoke then drain. Retry the SAME ban ID until complete. */
    ban(holder, reason, operationId) {
        return this.control(async () => {
            this.holder(holder);
            if (!reason.trim())
                throw new Error('Ban reason required');
            const key = this.banKey(holder);
            const previous = this.store.get(key);
            if (previous && previous.operationId !== operationId)
                throw new Error(`Resume existing ban ${previous.operationId}`);
            if (previous && previous.reason !== reason)
                throw new Error('Ban reason differs from the persisted decision');
            this.store.put(key, { reason, status: 'pending', operationId });
            let token = await readHolder(this.runner.client, this.id, holder);
            if (token || this.store.get(`tx:${operationId}:revoke`)) {
                // Revoke first: no new receipts, even if the zero-balance entry is deleted/recreated.
                await this.authorize(holder, true, `${operationId}:revoke`);
                token = await readHolder(this.runner.client, this.id, holder);
            }
            // Reconcile an already-journaled drain even if the holder deleted its
            // now-empty entry after the ledger applied it but before our receipt saved.
            if ((token && BigInt(token.MPTAmount) > 0n) || this.store.get(`tx:${operationId}:drain`)) {
                await this.claw(holder, MAX_MPT, `${operationId}:drain`);
            }
            token = await readHolder(this.runner.client, this.id, holder);
            if (token && (BigInt(token.MPTAmount) !== 0n || (token.Flags & 2)))
                throw new Error('Ban incomplete; retry same operation ID');
            this.store.put(key, { reason, status: 'complete', operationId });
        });
    }
    authorize(holder, revoke, id) {
        return this.runner.send(id, { TransactionType: 'MPTokenAuthorize', Account: this.signer.classicAddress,
            MPTokenIssuanceID: this.id, Holder: holder, Flags: revoke ? AuthFlags.tfMPTUnauthorize : 0 }, this.signer);
    }
    lock(frozen, id, holder) {
        return this.runner.send(id, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.classicAddress,
            MPTokenIssuanceID: this.id, Flags: frozen ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock,
            ...(holder ? { Holder: holder } : {}) }, this.signer);
    }
    claw(holder, value, id) {
        return this.runner.send(id, { TransactionType: 'Clawback', Account: this.signer.classicAddress,
            Holder: holder, Amount: { mpt_issuance_id: this.id, value } }, this.signer);
    }
}
//# sourceMappingURL=issuer.js.map