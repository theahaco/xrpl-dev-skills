import { isValidClassicAddress, MPTokenIssuanceCreateFlags as CreateFlags, MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags as AuthFlags, } from 'xrpl';
import { LedgerFailure } from './transactions.js';
export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export const MAX_AMOUNT = '9223372036854775807';
export const CAPABILITIES = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
    CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export function amount(value) {
    if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_AMOUNT)) {
        throw new Error('Amount must be a positive integer string <= 2^63-1 (base units)');
    }
    return value;
}
export function address(value) {
    if (!isValidClassicAddress(value))
        throw new Error('A classic XRPL address is required');
    return value;
}
export function issuanceID(value) {
    if (!/^[A-F0-9]{48}$/.test(value))
        throw new Error('Invalid MPT issuance ID');
    return value;
}
export function payment(account, destination, id, value) {
    return { TransactionType: 'Payment', Account: address(account), Destination: address(destination),
        Amount: { mpt_issuance_id: issuanceID(id), value: amount(value) } };
}
/** Native MPT locks permit redemption to the issuer, even while frozen. */
export class MptIssuer {
    transactions;
    wallet;
    issuanceId;
    store;
    tail = Promise.resolve();
    constructor(transactions, wallet, issuanceId, store) {
        this.transactions = transactions;
        this.wallet = wallet;
        this.issuanceId = issuanceId;
        this.store = store;
    }
    get client() { return this.transactions.client; }
    get issuerAddress() { return this.wallet.classicAddress; }
    serial(fn) {
        const result = this.tail.then(fn);
        this.tail = result.catch(() => undefined);
        return result;
    }
    static async create(transactions, wallet, operationId, maximumAmount = '1000000000') {
        const receipt = await transactions.submit(operationId, {
            TransactionType: 'MPTokenIssuanceCreate', Account: wallet.classicAddress,
            Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: amount(maximumAmount),
        }, wallet);
        const id = receipt.meta.mpt_issuance_id;
        if (!id)
            throw new Error('Validated creation metadata missing issuance ID');
        return MptIssuer.attach(transactions, wallet, id);
    }
    static async attach(transactions, wallet, id) {
        const module = new MptIssuer(transactions, wallet, issuanceID(id), transactions.store);
        const state = await module.issuance();
        if (state.Issuer !== wallet.classicAddress || (state.Flags & CAPABILITIES) !== CAPABILITIES ||
            (state.Flags & (8 | 16 | 128)) !== 0 || state.DomainID || (state.TransferFee ?? 0) !== 0 ||
            (state.AssetScale ?? 0) !== 0)
            throw new Error('Unsupported issuance configuration');
        return module;
    }
    async issuance(ledger = 'validated') {
        const response = await this.client.request({ command: 'ledger_entry',
            mpt_issuance: this.issuanceId, ledger_index: ledger });
        if (response.result.node.LedgerEntryType !== 'MPTokenIssuance')
            throw new Error('Wrong ledger entry');
        return response.result.node;
    }
    async holder(holder, ledger = 'validated') {
        try {
            const response = await this.client.request({ command: 'ledger_entry',
                mptoken: { mpt_issuance_id: this.issuanceId, account: address(holder) }, ledger_index: ledger });
            // xrpl's LedgerEntry union currently omits MPToken; validate the relevant fields.
            const node = response.result.node;
            // rippled omits default-valued zero amounts from JSON ledger entries.
            node.MPTAmount ??= '0';
            if (node.LedgerEntryType !== 'MPToken' || typeof node.MPTAmount !== 'string' ||
                !/^[0-9]+$/.test(node.MPTAmount) || !Number.isInteger(node.Flags) ||
                node.MPTokenIssuanceID !== this.issuanceId)
                throw new Error('Invalid MPToken ledger entry');
            return node;
        }
        catch (error) {
            if (error.data?.error === 'entryNotFound')
                return undefined;
            throw error;
        }
    }
    banKey(holder) { return `ban:${this.issuanceId}:${address(holder)}`; }
    allowed(holder) {
        if (holder === this.issuerAddress)
            throw new Error('Holder cannot be issuer');
        if (this.store.get(this.banKey(holder)))
            throw new Error('Address is permanently banned');
    }
    approve(holder, operationId) {
        return this.serial(async () => {
            this.allowed(holder);
            return this.transactions.submit(operationId, { TransactionType: 'MPTokenAuthorize',
                Account: this.issuerAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder }, this.wallet);
        });
    }
    mint(holder, value, operationId) {
        return this.serial(async () => {
            this.allowed(holder);
            const [token, issuance] = await Promise.all([this.holder(holder), this.issuance()]);
            if (!token || !(token.Flags & 2) || (token.Flags & 1) || (issuance.Flags & 1)) {
                throw new Error('Recipient is not authorized or token is frozen');
            }
            return this.transactions.submit(operationId, payment(this.issuerAddress, holder, this.issuanceId, value), this.wallet);
        });
    }
    clawback(holder, value, operationId) {
        return this.serial(() => this.clawbackInternal(holder, value, operationId));
    }
    clawbackInternal(holder, value, operationId) {
        if (holder === this.issuerAddress)
            throw new Error('Cannot claw back from issuer');
        return this.transactions.submit(operationId, { TransactionType: 'Clawback', Account: this.issuerAddress,
            Holder: address(holder), Amount: { mpt_issuance_id: this.issuanceId, value: amount(value) } }, this.wallet);
    }
    setHolderFrozen(holder, frozen, operationId) {
        return this.serial(() => {
            if (!frozen)
                this.allowed(holder);
            return this.lock(frozen, operationId, address(holder));
        });
    }
    setGlobalFrozen(frozen, operationId) {
        return this.serial(() => this.lock(frozen, operationId));
    }
    lock(frozen, operationId, holder) {
        return this.transactions.submit(operationId, { TransactionType: 'MPTokenIssuanceSet',
            Account: this.issuerAddress, MPTokenIssuanceID: this.issuanceId,
            Flags: frozen ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock,
            ...(holder ? { Holder: holder } : {}) }, this.wallet);
    }
    /** Resumable, fail-closed saga. Keep the same operation ID when retrying. No unban API. */
    ban(holder, operationId) {
        return this.serial(async () => {
            if (holder === this.issuerAddress)
                throw new Error('Cannot ban issuer');
            const key = this.banKey(holder);
            const existing = this.store.get(key);
            const id = existing?.operationId ?? operationId;
            this.store.put(key, { operationId: id, status: 'pending' });
            const pending = this.store.get(`pending:${this.issuerAddress}`);
            if (pending === `${id}:revoke` || pending === `${id}:lock` || pending === `${id}:drain`) {
                // Resolve even if the holder redeemed/deleted their holding since the last attempt.
                try {
                    await this.transactions.resumePending(this.wallet);
                }
                catch (error) {
                    if (!(error instanceof LedgerFailure) || pending !== `${id}:drain` ||
                        error.receipt.code !== 'tecNO_LINE')
                        throw error;
                }
            }
            else if (pending)
                throw new Error(`Reconcile pending operation ${pending} first`);
            if (await this.holder(holder)) {
                // Revoke first: no further receipts while we drain; redemption may reduce the balance.
                await this.transactions.submit(`${id}:revoke`, { TransactionType: 'MPTokenAuthorize',
                    Account: this.issuerAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder,
                    Flags: AuthFlags.tfMPTUnauthorize }, this.wallet);
                if (await this.holder(holder))
                    await this.lock(true, `${id}:lock`, holder);
                const state = await this.holder(holder);
                if (state && BigInt(state.MPTAmount) > 0n) {
                    // Protocol clamps to the available balance; avoids a stale balance calculation.
                    try {
                        await this.clawbackInternal(holder, MAX_AMOUNT, `${id}:drain`);
                    }
                    catch (error) {
                        const current = await this.holder(holder);
                        if (current && BigInt(current.MPTAmount) !== 0n)
                            throw error;
                        // Only a validated no-balance result can be safely ignored.
                        if (!(error instanceof LedgerFailure) || error.receipt.code !== 'tecNO_LINE')
                            throw error;
                    }
                }
            }
            const final = await this.holder(holder);
            if (final && (BigInt(final.MPTAmount) !== 0n || (final.Flags & 2)))
                throw new Error('Ban incomplete');
            this.store.put(key, { operationId: id, status: 'complete' });
        });
    }
}
