import { isValidClassicAddress, MPTokenIssuanceCreateFlags as CreateFlags, MPTokenAuthorizeFlags, MPTokenIssuanceSetFlags, } from 'xrpl';
import { SerialQueue } from './store.js';
import { LedgerFailure } from './transactions.js';
export const MAX_AMOUNT = '9223372036854775807';
export const ISSUANCE_FLAGS = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
    CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export function amount(value) {
    if (typeof value !== 'string' || value.length > 19 || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_AMOUNT))
        throw new Error('Amount must be a positive integer string within MPT range');
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
export function createIssuanceTx(issuer, maximumAmount) {
    return { TransactionType: 'MPTokenIssuanceCreate', Account: address(issuer), Flags: ISSUANCE_FLAGS,
        AssetScale: 0, MaximumAmount: amount(maximumAmount) };
}
export function paymentTx(id, from, to, value) {
    return { TransactionType: 'Payment', Account: address(from), Destination: address(to),
        Amount: { mpt_issuance_id: issuanceId(id), value: amount(value) } };
}
export class XrplLedgerReader {
    client;
    constructor(client) {
        this.client = client;
    }
    async issuance(id, ledger) {
        const response = await this.client.request({ command: 'ledger_entry', mpt_issuance: issuanceId(id), ledger_index: ledger ?? 'validated' });
        if (!response.result.validated || response.result.node.LedgerEntryType !== 'MPTokenIssuance')
            throw new Error('Invalid issuance response');
        return response.result.node;
    }
    async holding(id, holder, ledger) {
        try {
            const response = await this.client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: issuanceId(id), account: address(holder) }, ledger_index: ledger ?? 'validated' });
            // xrpl's LedgerEntry union omits MPToken, despite supporting the RPC selector.
            const node = response.result.node;
            if (!response.result.validated || node.LedgerEntryType !== 'MPToken' || node.MPTokenIssuanceID !== id)
                throw new Error('Invalid holding response');
            return node;
        }
        catch (error) {
            if (error.data?.error === 'entryNotFound')
                return undefined;
            throw error;
        }
    }
}
/** Native MPT locks exempt payments involving the issuer. They are NOT an absolute movement halt. */
export class MptIssuer {
    id;
    runner;
    ledger;
    store;
    queue = new SerialQueue();
    constructor(id, runner, ledger, store) {
        this.id = id;
        this.runner = runner;
        this.ledger = ledger;
        this.store = store;
        issuanceId(id);
    }
    static async create(runner, ledger, store, key, maximumAmount = '1000000000') {
        const receipt = await runner.execute(key, createIssuanceTx(runner.address, maximumAmount));
        if (!receipt.issuanceId)
            throw new Error(`Missing issuance ID in validated metadata: ${receipt.hash}`);
        const issuer = new MptIssuer(receipt.issuanceId, runner, ledger, store);
        await issuer.checkCapabilities();
        return issuer;
    }
    async checkCapabilities() {
        const state = await this.ledger.issuance(this.id);
        if (state.Issuer !== this.runner.address || (state.Flags & ISSUANCE_FLAGS) !== ISSUANCE_FLAGS ||
            (state.Flags & (8 | 16 | 128)) !== 0 || state.DomainID)
            throw new Error('Unsupported issuer or compliance capabilities');
    }
    holder(holder) {
        address(holder);
        if (holder === this.runner.address)
            throw new Error('Issuer cannot be a holder');
        return holder;
    }
    banKey(holder) { return `ban:${this.id}:${this.holder(holder)}`; }
    async assertNotBanned(holder) {
        if (await this.store.get(this.banKey(holder)))
            throw new Error('Holder is banned');
    }
    approve(holder, key) {
        return this.queue.run(async () => {
            await this.checkCapabilities();
            await this.assertNotBanned(holder);
            return this.runner.execute(key, { TransactionType: 'MPTokenAuthorize', Account: this.runner.address, MPTokenIssuanceID: this.id, Holder: holder });
        });
    }
    mint(holder, value, key) {
        amount(value);
        return this.queue.run(async () => {
            await this.checkCapabilities();
            await this.assertNotBanned(holder);
            const issuance = await this.ledger.issuance(this.id);
            const holding = await this.ledger.holding(this.id, holder);
            if ((issuance.Flags & 1) !== 0 || ((holding?.Flags ?? 0) & 1) !== 0)
                throw new Error('Mint blocked: issuance or holder is frozen');
            if (((holding?.Flags ?? 0) & 2) === 0)
                throw new Error('Mint blocked: holder is not authorized');
            return this.runner.execute(key, paymentTx(this.id, this.runner.address, holder, value));
        });
    }
    clawback(holder, value, key) {
        this.holder(holder);
        amount(value);
        return this.queue.run(async () => { await this.checkCapabilities(); return this.clawbackTx(holder, value, key); });
    }
    clawbackTx(holder, value, key) {
        return this.runner.execute(key, { TransactionType: 'Clawback', Account: this.runner.address, Holder: holder,
            Amount: { mpt_issuance_id: this.id, value } });
    }
    freezeHolder(holder, key) { return this.lock(true, key, this.holder(holder)); }
    unfreezeHolder(holder, key) { return this.lock(false, key, this.holder(holder)); }
    freezeGlobal(key) { return this.lock(true, key); }
    unfreezeGlobal(key) { return this.lock(false, key); }
    lock(locked, key, holder) {
        return this.queue.run(async () => {
            await this.checkCapabilities();
            if (holder && !locked)
                await this.assertNotBanned(holder);
            return this.lockTx(locked, key, holder);
        });
    }
    lockTx(locked, key, holder) {
        return this.runner.execute(key, { TransactionType: 'MPTokenIssuanceSet', Account: this.runner.address,
            MPTokenIssuanceID: this.id, Flags: locked ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
            ...(holder ? { Holder: holder } : {}) });
    }
    /** Resumable saga: durable ban -> revoke permission -> lock -> drain -> verify.
     * Revocation validates BEFORE draining so new receipts cannot race the drain.
     * Pending bans block approval/unlock/mint even after a crash. No unban API.
     */
    ban(holder, key, reason) {
        const storeKey = this.banKey(holder);
        if (!key || !reason.trim())
            throw new Error('Ban requires operation key and audit reason');
        return this.queue.run(async () => {
            await this.checkCapabilities();
            const prior = await this.store.get(storeKey);
            const ban = prior ?? { status: 'pending', operation: key, reason };
            await this.store.put(storeKey, ban);
            const holding = await this.ledger.holding(this.id, holder);
            if (holding) {
                await this.runner.execute(`${ban.operation}:revoke`, { TransactionType: 'MPTokenAuthorize', Account: this.runner.address,
                    MPTokenIssuanceID: this.id, Holder: holder, Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize });
                await this.lockTx(true, `${ban.operation}:lock`, holder);
                const current = await this.ledger.holding(this.id, holder);
                if (ban.drainStarted || BigInt(current?.MPTAmount ?? '0') > 0n) {
                    ban.drainStarted = true;
                    await this.store.put(storeKey, ban);
                    try {
                        await this.clawbackTx(holder, MAX_AMOUNT, `${ban.operation}:drain`);
                    }
                    catch (error) {
                        // A holder can redeem while locked; accept an empty balance only after
                        // the clawback has a definitive validated result and postconditions pass.
                        if (!(error instanceof LedgerFailure) || error.receipt.code !== 'tecNO_LINE')
                            throw error;
                    }
                }
            }
            const final = await this.ledger.holding(this.id, holder);
            if (BigInt(final?.MPTAmount ?? '0') !== 0n || ((final?.Flags ?? 0) & 2) !== 0)
                throw new Error('Ban postcondition failed; resume ban');
            await this.store.put(storeKey, { ...ban, status: 'complete' });
        });
    }
}
