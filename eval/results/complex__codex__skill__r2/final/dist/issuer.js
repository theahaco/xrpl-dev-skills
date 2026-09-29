import { isValidClassicAddress, MPTokenIssuanceCreateFlags as CreateFlags, } from 'xrpl';
export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export const CAPABILITIES = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
    CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export const MAX_AMOUNT = (2n ** 63n - 1n).toString();
export function amount(value) {
    if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_AMOUNT)) {
        throw new Error('Amount must be a positive canonical integer up to 2^63-1 (base units)');
    }
    return value;
}
export function holderAddress(value, issuer) {
    if (!isValidClassicAddress(value) || value === issuer)
        throw new Error('Invalid holder address');
    return value;
}
export function issuanceId(value) {
    if (!/^[A-F0-9]{48}$/.test(value))
        throw new Error('Invalid MPT issuance ID');
    return value;
}
export function walletSigner(wallet) {
    return { address: wallet.classicAddress, sign: async (tx) => wallet.sign(tx) };
}
export class LedgerFailure extends Error {
    receipt;
    constructor(receipt) {
        super(`Validated transaction failed: ${receipt.code} (${receipt.hash})`);
        this.receipt = receipt;
    }
}
export class UncertainSubmission extends Error {
    operation;
    hash;
    constructor(operation, hash, options) {
        super(`Submission outcome unresolved; reconcile operation ${operation}, hash ${hash}; never retry with a new operation ID`, options);
        this.operation = operation;
        this.hash = hash;
    }
}
export class Mutex {
    tail = Promise.resolve();
    run(fn) {
        const next = this.tail.then(fn);
        this.tail = next.catch(() => undefined);
        return next;
    }
}
/** One executor per signing account/work queue. No other process may use its sequences. */
export class TransactionExecutor {
    client;
    store;
    mutex = new Mutex();
    constructor(client, store) {
        this.client = client;
        this.store = store;
    }
    async assertTestnet() {
        const info = (await this.client.request({ command: 'server_info' })).result.info;
        if (info.network_id !== 1)
            throw new Error('Refusing network other than XRPL Testnet (network_id 1)');
    }
    async execute(key, tx, signer) {
        return this.mutex.run(async () => {
            if (!key || tx.Account !== signer.address)
                throw new Error('Operation ID and matching signer required');
            await this.assertTestnet();
            const intent = JSON.stringify(tx);
            let op = await this.store.getOperation(key);
            if (op && op.intent !== intent)
                throw new Error('Operation ID reused with a different transaction');
            if (op?.receipt)
                return this.success(op.receipt);
            const pending = await this.store.pendingOperation();
            if (pending && pending !== key)
                throw new Error(`Resolve pending operation ${pending} first`);
            if (!op) {
                const prepared = await this.client.autofill(tx);
                if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 1000n) {
                    throw new Error('Missing expiry or fee exceeds 0.001 XRP cap');
                }
                const signed = await signer.sign(prepared);
                op = { intent, blob: signed.tx_blob, hash: signed.hash, lastLedger: prepared.LastLedgerSequence };
                await this.store.putOperation(key, op);
            }
            let result;
            try {
                // Resubmission uses the identical signed blob; it cannot apply twice.
                result = (await this.client.submitAndWait(op.blob)).result;
            }
            catch (cause) {
                try {
                    result = (await this.client.request({ command: 'tx', transaction: op.hash })).result;
                }
                catch {
                    throw new UncertainSubmission(key, op.hash, { cause });
                }
            }
            if (!result.validated || !result.ledger_index || typeof result.meta !== 'object' || result.meta === null) {
                throw new UncertainSubmission(key, op.hash);
            }
            const receipt = {
                hash: op.hash, ledgerIndex: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta,
            };
            await this.store.putOperation(key, { ...op, receipt });
            return this.success(receipt);
        });
    }
    success(receipt) {
        if (receipt.code !== 'tesSUCCESS')
            throw new LedgerFailure(receipt);
        return receipt;
    }
}
/** Backend API. KYC approval is the caller's responsibility; no PII goes on-ledger. */
export class MptIssuer {
    executor;
    signer;
    id;
    mutex = new Mutex();
    constructor(executor, signer, id) {
        this.executor = executor;
        this.signer = signer;
        this.id = id;
        issuanceId(id);
    }
    static async create(executor, signer, key) {
        const receipt = await executor.execute(key, {
            TransactionType: 'MPTokenIssuanceCreate', Account: signer.address,
            Flags: CAPABILITIES, AssetScale: 0, MaximumAmount: '1000000000', TransferFee: 0,
            MPTokenMetadata: Buffer.from(JSON.stringify({ n: 'Compliance Test Token', t: 'CTEST',
                d: 'Testnet only; no monetary value or backing claim', ac: 'other' })).toString('hex').toUpperCase(),
        }, signer);
        const meta = receipt.meta;
        if (!meta.mpt_issuance_id)
            throw new Error('Validated create missing issuance ID');
        const issuer = new MptIssuer(executor, signer, meta.mpt_issuance_id);
        await issuer.assertCapabilities();
        return issuer;
    }
    async issuance(ledger = 'validated') {
        const response = await this.executor.client.request({ command: 'ledger_entry', mpt_issuance: this.id, ledger_index: ledger });
        if (response.result.node.LedgerEntryType !== 'MPTokenIssuance')
            throw new Error('Wrong ledger entry');
        return response.result.node;
    }
    async holder(address, ledger = 'validated') {
        holderAddress(address, this.signer.address);
        try {
            const response = await this.executor.client.request({ command: 'ledger_entry',
                mptoken: { mpt_issuance_id: this.id, account: address }, ledger_index: ledger });
            if (response.result.node.LedgerEntryType !== 'MPToken')
                throw new Error('Wrong ledger entry');
            // rippled omits default zero-valued fields from serialized ledger objects.
            const entry = response.result.node;
            return { ...entry, MPTAmount: entry.MPTAmount ?? '0' };
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'data' in error &&
                error.data?.error === 'entryNotFound')
                return undefined;
            throw error;
        }
    }
    async assertCapabilities() {
        const entry = await this.issuance();
        if (entry.Issuer !== this.signer.address || (entry.Flags & CAPABILITIES) !== CAPABILITIES ||
            (entry.Flags & (8 | 16 | 128)) !== 0 || (entry.AssetScale ?? 0) !== 0) {
            throw new Error('Unexpected issuer, capabilities or scale; refusing to manage issuance');
        }
    }
    async allowed(address) {
        holderAddress(address, this.signer.address);
        if (await this.executor.store.isBanned(this.id, address))
            throw new Error('Address is permanently banned by compliance policy');
    }
    send(key, tx) {
        return this.executor.execute(`${this.id}:${key}`, tx, this.signer);
    }
    approve(address, key) {
        return this.mutex.run(async () => {
            await this.allowed(address);
            await this.assertCapabilities();
            return this.send(key, { TransactionType: 'MPTokenAuthorize', Account: this.signer.address,
                MPTokenIssuanceID: this.id, Holder: address });
        });
    }
    mint(address, value, key) {
        return this.mutex.run(async () => {
            await this.allowed(address);
            amount(value);
            await this.assertCapabilities();
            const [issuance, holding] = await Promise.all([this.issuance(), this.holder(address)]);
            if ((issuance.Flags & 1) !== 0 || (holding && (holding.Flags & 1) !== 0)) {
                throw new Error('Mint blocked by freeze policy');
            }
            return this.send(key, { TransactionType: 'Payment', Account: this.signer.address,
                Destination: address, Amount: { mpt_issuance_id: this.id, value } });
        });
    }
    clawback(address, value, key) {
        return this.mutex.run(() => this.clawbackInternal(address, value, key));
    }
    async clawbackInternal(address, value, key) {
        holderAddress(address, this.signer.address);
        amount(value);
        await this.assertCapabilities();
        return this.send(key, { TransactionType: 'Clawback', Account: this.signer.address,
            Holder: address, Amount: { mpt_issuance_id: this.id, value } });
    }
    setFrozen(address, frozen, key) {
        return this.mutex.run(async () => {
            holderAddress(address, this.signer.address);
            if (!frozen)
                await this.allowed(address);
            await this.assertCapabilities();
            return this.lock(address, frozen, key);
        });
    }
    setGlobalFrozen(frozen, key) {
        return this.mutex.run(async () => { await this.assertCapabilities(); return this.lock(undefined, frozen, key); });
    }
    lock(address, frozen, key) {
        return this.send(key, { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.address,
            MPTokenIssuanceID: this.id, Flags: frozen ? 1 : 2, ...(address ? { Holder: address } : {}) });
    }
    /** Resumable, fail-closed workflow; not an atomic ledger transaction. Repeat with the SAME key. */
    ban(address, key) {
        return this.mutex.run(async () => {
            holderAddress(address, this.signer.address);
            await this.assertCapabilities();
            await this.executor.store.markBanned(this.id, address);
            // Reconcile a previously broadcast stage even if it changed the balance to zero.
            for (const stage of ['lock', 'revoke', 'sweep']) {
                const operationKey = `${this.id}:${key}:${stage}`;
                const prior = await this.executor.store.getOperation(operationKey);
                if (prior && !prior.receipt) {
                    await this.executor.execute(operationKey, JSON.parse(prior.intent), this.signer);
                }
            }
            const existing = await this.holder(address);
            if (existing) {
                await this.lock(address, true, `${key}:lock`);
                await this.send(`${key}:revoke`, { TransactionType: 'MPTokenAuthorize', Account: this.signer.address,
                    MPTokenIssuanceID: this.id, Holder: address, Flags: 1 });
                const balance = await this.holder(address);
                // Maximum request sweeps even if balance changed. Clawback is capped at actual holdings.
                if (balance && BigInt(balance.MPTAmount) > 0n) {
                    await this.clawbackInternal(address, MAX_AMOUNT, `${key}:sweep`);
                }
            }
            const final = await this.holder(address);
            if (final && (BigInt(final.MPTAmount) !== 0n || (final.Flags & 2) !== 0)) {
                throw new Error('Ban incomplete: retry the same ban operation');
            }
        });
    }
}
