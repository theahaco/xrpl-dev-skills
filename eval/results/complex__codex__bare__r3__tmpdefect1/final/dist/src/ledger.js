import { decode, encode, hashes } from 'xrpl';
import { isDeepStrictEqual } from 'node:util';
import { errorCode } from './store.js';
export const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233';
export function validateOperationId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9:._-]{1,200}$/.test(id))
        throw new Error('Invalid operation ID');
}
export class TransactionFailed extends Error {
    receipt;
    constructor(receipt) {
        super(`${receipt.code}: ${receipt.hash}`);
        this.receipt = receipt;
    }
}
export class OutcomeUnknown extends Error {
    hash;
    constructor(hash, cause) {
        super(`Outcome unresolved for ${hash}; retry SAME operation ID; do not create a replacement payment`, { cause });
        this.hash = hash;
    }
}
/** Share one executor for all callers using this issuer; it owns account sequence allocation. */
export class LedgerExecutor {
    client;
    store;
    tail = Promise.resolve();
    constructor(client, store) {
        this.client = client;
        this.store = store;
    }
    async checkNetwork() {
        const { result } = await this.client.request({ command: 'server_info' });
        if (result.info.network_id !== 1)
            throw new Error('Refusing non-testnet network (expected network_id 1)');
        if (!result.info.validated_ledger || result.info.validated_ledger.age > 30)
            throw new Error('Server is not fresh');
    }
    exclusive(work) {
        const next = this.tail.then(work);
        this.tail = next.catch(() => undefined);
        return next;
    }
    async execute(id, tx, signer) {
        return this.exclusive(() => this.transact(id, tx, signer));
    }
    /** Reconcile the durable pending transaction before restarting a composite operation. */
    async reconcilePending() {
        return this.exclusive(async () => {
            const id = await this.store.get('pendingTransaction');
            if (!id)
                return undefined;
            const journal = await this.store.get(`tx:${id}`);
            if (!journal)
                throw new Error('Corrupt journal: pending transaction missing');
            const tx = JSON.parse(journal.intent);
            return this.transact(id, tx, { address: tx.Account, sign: () => { throw new Error('Recovery must reuse signed bytes'); } });
        });
    }
    /** Used inside exclusive() by composite issuer operations. */
    async transact(id, tx, signer) {
        validateOperationId(id);
        if (tx.Account !== signer.address)
            throw new Error('Signer/account mismatch');
        const intent = JSON.stringify(tx);
        let journal = await this.store.get(`tx:${id}`);
        if (journal && journal.intent !== intent)
            throw new Error(`Operation ID reused with different payload: ${id}`);
        const active = await this.store.get('pendingTransaction');
        if (journal?.receipt) {
            if (active === id)
                await this.store.set('pendingTransaction', '');
            return journal.receipt;
        }
        if (active && active !== id)
            throw new Error(`Reconcile pending operation ${active} before further mutations`);
        await this.checkNetwork();
        if (!journal) {
            const prepared = await this.client.autofill(tx);
            if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 1000n)
                throw new Error('Missing expiry or excessive fee');
            const signed = await signer.sign(prepared);
            if (hashes.hashSignedTx(signed.tx_blob) !== signed.hash)
                throw new Error('Signer returned inconsistent hash');
            const decoded = decode(signed.tx_blob);
            delete decoded.SigningPubKey;
            delete decoded.TxnSignature;
            delete decoded.Signers;
            const expected = decode(encode(prepared));
            delete expected.SigningPubKey;
            if (!isDeepStrictEqual(decoded, expected))
                throw new Error('Signer modified transaction');
            journal = { intent, blob: signed.tx_blob, hash: signed.hash, lastLedger: prepared.LastLedgerSequence };
            // Persist signed bytes BEFORE they can reach the network.
            await this.store.set(`tx:${id}`, journal);
        }
        await this.store.set('pendingTransaction', id);
        try {
            let response;
            try {
                response = await this.client.request({ command: 'tx', transaction: journal.hash });
            }
            catch (error) {
                if (errorCode(error) !== 'txnNotFound')
                    throw error;
            }
            if (!response?.result.validated)
                response = await this.client.submitAndWait(journal.blob);
            const result = response.result;
            if (!result.validated || typeof result.meta !== 'object' || !result.meta || !result.ledger_index)
                throw new Error('Missing validated metadata');
            const receipt = { hash: journal.hash, ledgerIndex: result.ledger_index, code: result.meta.TransactionResult, metadata: result.meta };
            await this.store.set(`tx:${id}`, { ...journal, receipt });
            await this.store.set('pendingTransaction', '');
            console.log(`${id}: ${receipt.code} ${receipt.hash}`);
            return receipt;
        }
        catch (error) {
            throw new OutcomeUnknown(journal.hash, error);
        }
    }
}
export function requireSuccess(receipt) {
    if (receipt.code !== 'tesSUCCESS')
        throw new TransactionFailed(receipt);
    return receipt;
}
//# sourceMappingURL=ledger.js.map