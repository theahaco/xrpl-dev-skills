export function walletSigner(wallet) {
    return { address: wallet.classicAddress, sign: async (tx) => wallet.sign(tx) };
}
export class LedgerFailure extends Error {
    receipt;
    constructor(receipt) {
        super(`${receipt.code}: ${receipt.hash}`);
        this.receipt = receipt;
    }
}
export class Serial {
    tail = Promise.resolve();
    run(fn) {
        const next = this.tail.then(fn);
        this.tail = next.catch(() => undefined);
        return next;
    }
}
/** A key is permanently bound to one intent. Persist signed bytes before sending. */
export class Transactions {
    client;
    store;
    serial = new Serial();
    /** Shared by issuer instances to serialize multi-transaction compliance operations. */
    complianceSerial = new Serial();
    constructor(client, store) {
        this.client = client;
        this.store = store;
    }
    /** Read a completed outcome without executing it, with the same intent binding. */
    completed(key, tx) {
        const saved = this.store.get(`tx:${key}`);
        if (saved && saved.intent !== JSON.stringify(tx))
            throw new Error(`Operation id reused with different intent: ${key}`);
        return saved?.receipt ? this.accept(saved.receipt) : undefined;
    }
    async checkTestnet() {
        const info = (await this.client.request({ command: 'server_info' })).result.info;
        if (info.network_id !== 1)
            throw new Error('Refusing to sign outside XRPL testnet (network_id 1)');
    }
    submit(key, tx, signer) {
        return this.serial.run(async () => {
            if (!key.trim())
                throw new Error('An operation id is required');
            if (tx.Account !== signer.address)
                throw new Error('Signer/account mismatch');
            await this.checkTestnet();
            const intent = JSON.stringify(tx);
            let saved = this.store.get(`tx:${key}`);
            if (saved && saved.intent !== intent)
                throw new Error(`Operation id reused with different intent: ${key}`);
            if (saved?.receipt) {
                if (this.store.get('unresolved') === key)
                    this.store.set('unresolved', null);
                return this.accept(saved.receipt);
            }
            const unresolved = this.store.get('unresolved');
            if (unresolved && unresolved !== key)
                throw new Error(`Resolve pending operation ${unresolved} before submitting ${key}`);
            if (!saved) {
                const prepared = await this.client.autofill(tx);
                if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 1000n)
                    throw new Error('Missing expiry or fee exceeds 1000 drops');
                const signed = await signer.sign(prepared);
                saved = { intent, blob: signed.tx_blob, hash: signed.hash };
                this.store.atomic(() => {
                    this.store.set(`tx:${key}`, saved);
                    this.store.set('unresolved', key);
                });
            }
            this.store.set('unresolved', key);
            let receipt;
            try {
                const prior = await this.client.request({ command: 'tx', transaction: saved.hash });
                if (prior.result.validated && typeof prior.result.ledger_index === 'number' && typeof prior.result.meta === 'object')
                    receipt = { hash: saved.hash, ledgerIndex: prior.result.ledger_index, code: prior.result.meta.TransactionResult, meta: prior.result.meta };
            }
            catch (error) {
                if (!(error instanceof Error && 'data' in error && error.data.error === 'txnNotFound'))
                    throw error;
            }
            if (!receipt) {
                const { result } = await this.client.submitAndWait(saved.blob);
                if (!result.validated || typeof result.ledger_index !== 'number' || typeof result.meta !== 'object')
                    throw new Error(`Uncertain transaction outcome: ${saved.hash}`);
                receipt = { hash: saved.hash, ledgerIndex: result.ledger_index, code: result.meta.TransactionResult, meta: result.meta };
            }
            this.store.atomic(() => {
                this.store.set(`tx:${key}`, { ...saved, receipt });
                this.store.set('unresolved', null);
            });
            console.log(`${key}: ${receipt.code} ${receipt.hash}`);
            return this.accept(receipt);
        });
    }
    accept(receipt) {
        if (receipt.code !== 'tesSUCCESS')
            throw new LedgerFailure(receipt);
        return receipt;
    }
}
