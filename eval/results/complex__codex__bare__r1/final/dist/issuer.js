import { isValidClassicAddress, MPTokenIssuanceCreateFlags as F } from 'xrpl';
export const MAX_AMOUNT = 9223372036854775807n;
export const CAPABILITIES = F.tfMPTCanLock | F.tfMPTRequireAuth | F.tfMPTCanTransfer | F.tfMPTCanClawback;
export function amount(value) {
    if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > MAX_AMOUNT)
        throw new Error('Amount must be a positive integer string <= 2^63-1 (base units)');
    return value;
}
export class LedgerFailure extends Error {
    code;
    hash;
    constructor(code, hash) {
        super(`${code}: ${hash}`);
        this.code = code;
        this.hash = hash;
    }
}
/** One runner per signing account; backend must additionally enforce a distributed single writer. */
export class TransactionRunner {
    client;
    audit;
    tail = Promise.resolve();
    constructor(client, audit) {
        this.client = client;
        this.audit = audit;
    }
    submit(wallet, transaction) {
        const task = this.tail.then(async () => {
            const info = (await this.client.request({ command: 'server_info' })).result.info;
            if (info.network_id !== 1)
                throw new Error('Refusing to sign outside XRPL testnet (network 1)');
            if (transaction.Account !== wallet.classicAddress)
                throw new Error('Signer/account mismatch');
            const prepared = await this.client.autofill(transaction);
            if (BigInt(prepared.Fee ?? '0') > 1000n)
                throw new Error('Fee exceeds 1000 drops');
            const signed = wallet.sign(prepared);
            await this.audit({ phase: 'prepared', hash: signed.hash, transaction: prepared, blob: signed.tx_blob });
            // Never re-sign automatically after an ambiguous timeout. Reconcile the recorded hash.
            const response = await this.client.submitAndWait(signed.tx_blob);
            const result = response.result;
            if (!result.validated || typeof result.meta !== 'object' || result.ledger_index === undefined)
                throw new Error(`Unconfirmed transaction ${signed.hash}`);
            const code = result.meta.TransactionResult;
            await this.audit({ phase: 'validated', hash: signed.hash, result: code, ledger: result.ledger_index });
            if (code !== 'tesSUCCESS')
                throw new LedgerFailure(code, signed.hash);
            return { hash: signed.hash, meta: result.meta, ledger_index: result.ledger_index };
        });
        this.tail = task.catch(() => undefined);
        return task;
    }
}
export async function objects(client, account, ledger = 'validated') {
    const entries = [];
    let marker;
    let index = ledger;
    do {
        const response = await client.request({ command: 'account_objects', account, ledger_index: index, ...(marker === undefined ? {} : { marker }) });
        if (!response.result.validated)
            throw new Error('Expected validated ledger');
        if (response.result.ledger_index === undefined)
            throw new Error('Missing ledger index');
        index = response.result.ledger_index;
        entries.push(...response.result.account_objects);
        marker = response.result.marker;
    } while (marker !== undefined);
    return entries;
}
export class MptIssuer {
    runner;
    wallet;
    issuanceId;
    policy;
    tail = Promise.resolve();
    constructor(runner, wallet, issuanceId, policy) {
        this.runner = runner;
        this.wallet = wallet;
        this.issuanceId = issuanceId;
        this.policy = policy;
    }
    static async create(runner, wallet, policy) {
        const result = await runner.submit(wallet, { TransactionType: 'MPTokenIssuanceCreate', Account: wallet.classicAddress, Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: MAX_AMOUNT.toString() });
        const meta = result.meta;
        if (typeof meta !== 'object' || meta === null || !('mpt_issuance_id' in meta) || typeof meta.mpt_issuance_id !== 'string')
            throw new Error('Missing issuance ID; reconcile creation hash');
        return MptIssuer.attach(runner, wallet, meta.mpt_issuance_id, policy);
    }
    static async attach(runner, wallet, id, policy) {
        if (!/^[A-Fa-f0-9]{48}$/.test(id))
            throw new Error('Invalid issuance ID');
        const service = new MptIssuer(runner, wallet, id.toUpperCase(), policy);
        const issuance = await service.issuance();
        if ((issuance.Flags & CAPABILITIES) !== CAPABILITIES || (issuance.Flags & (8 | 16 | 128)) !== 0)
            throw new Error('Issuance has incompatible capabilities');
        return service;
    }
    serial(work) {
        const task = this.tail.then(work);
        this.tail = task.catch(() => undefined);
        return task;
    }
    holderAddress(holder) {
        if (!isValidClassicAddress(holder) || holder === this.wallet.classicAddress)
            throw new Error('Invalid holder');
    }
    async allowed(holder) {
        this.holderAddress(holder);
        if (await this.policy.isBanned(this.issuanceId, holder))
            throw new Error('Holder is permanently banned by policy');
    }
    send(transaction) { return this.runner.submit(this.wallet, transaction); }
    async issuance(ledger = 'validated') {
        const found = (await objects(this.runner.client, this.wallet.classicAddress, ledger)).find((entry) => entry.LedgerEntryType === 'MPTokenIssuance' && 'mpt_issuance_id' in entry && entry.mpt_issuance_id === this.issuanceId);
        if (!found || found.Issuer !== this.wallet.classicAddress)
            throw new Error('Issuance not owned by signer');
        return found;
    }
    async holder(holder, ledger = 'validated') {
        this.holderAddress(holder);
        return (await objects(this.runner.client, holder, ledger)).find((entry) => entry.LedgerEntryType === 'MPToken' && entry.MPTokenIssuanceID === this.issuanceId);
    }
    approve(holder) {
        return this.serial(async () => {
            await this.allowed(holder);
            return this.send({ TransactionType: 'MPTokenAuthorize', Account: this.wallet.classicAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder });
        });
    }
    issue(holder, value) {
        return this.serial(async () => {
            await this.allowed(holder);
            amount(value);
            const [issuance, state] = await Promise.all([this.issuance(), this.holder(holder)]);
            if ((issuance.Flags & 1) || !state || (state.Flags & 1) || !(state.Flags & 2))
                throw new Error('Holder unauthorized or frozen');
            return this.send({ TransactionType: 'Payment', Account: this.wallet.classicAddress, Destination: holder, Amount: { mpt_issuance_id: this.issuanceId, value } });
        });
    }
    lock(locked, holder) {
        return this.send({ TransactionType: 'MPTokenIssuanceSet', Account: this.wallet.classicAddress, MPTokenIssuanceID: this.issuanceId, Flags: locked ? 1 : 2, ...(holder ? { Holder: holder } : {}) });
    }
    freezeHolder(holder) { return this.serial(async () => { this.holderAddress(holder); return this.lock(true, holder); }); }
    unfreezeHolder(holder) { return this.serial(async () => { await this.allowed(holder); return this.lock(false, holder); }); }
    freezeGlobal() { return this.serial(() => this.lock(true)); }
    unfreezeGlobal() { return this.serial(() => this.lock(false)); }
    reclaim(holder, value) {
        this.holderAddress(holder);
        amount(value);
        return this.send({ TransactionType: 'Clawback', Account: this.wallet.classicAddress, Holder: holder, Amount: { mpt_issuance_id: this.issuanceId, value } });
    }
    clawback(holder, value) { return this.serial(() => this.reclaim(holder, value)); }
    /** Resumable, non-atomic saga. Revocation prevents new receipts before the balance is read. */
    ban(holder) {
        return this.serial(async () => {
            this.holderAddress(holder);
            await this.policy.ban(this.issuanceId, holder);
            let state = await this.holder(holder);
            if (!state)
                return;
            if (state.Flags & 2)
                await this.send({ TransactionType: 'MPTokenAuthorize', Account: this.wallet.classicAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: 1 });
            state = await this.holder(holder);
            if (state && BigInt(state.MPTAmount) > 0n)
                await this.reclaim(holder, MAX_AMOUNT.toString());
            state = await this.holder(holder);
            if (state && (BigInt(state.MPTAmount) !== 0n || (state.Flags & 2)))
                throw new Error('Ban incomplete; retry ban after reconciliation');
        });
    }
}
