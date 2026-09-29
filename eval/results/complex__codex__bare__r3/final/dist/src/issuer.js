import { isValidClassicAddress, MPTokenIssuanceCreateFlags as Create, MPTokenAuthorizeFlags as Authorize, MPTokenIssuanceSetFlags as SetFlags, } from 'xrpl';
import { requireSuccess, validateOperationId } from './ledger.js';
import { errorCode } from './store.js';
export const MAX_MPT_AMOUNT = '9223372036854775807';
export const ISSUANCE_FLAGS = Create.tfMPTCanLock | Create.tfMPTRequireAuth | Create.tfMPTCanTransfer | Create.tfMPTCanClawback;
export const HOLDER_LOCKED = 1;
export const HOLDER_AUTHORIZED = 2;
export function amount(value) {
    if (typeof value !== 'string' || value.length > 19 || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_MPT_AMOUNT))
        throw new Error('Amount must be a positive integer string <= 2^63-1');
    return value;
}
/** Classic transparent MPT, scale 0. KYC decisions are supplied by the backend. */
export class MptIssuer {
    ledger;
    signer;
    issuanceId;
    constructor(ledger, signer, issuanceId) {
        this.ledger = ledger;
        this.signer = signer;
        this.issuanceId = issuanceId;
        if (!/^[A-F0-9]{48}$/.test(issuanceId))
            throw new Error('Invalid issuance ID');
        if (!isValidClassicAddress(signer.address))
            throw new Error('Invalid issuer address');
    }
    static async create(ledger, signer, operationId) {
        const receipt = requireSuccess(await ledger.execute(operationId, {
            TransactionType: 'MPTokenIssuanceCreate', Account: signer.address,
            AssetScale: 0, MaximumAmount: MAX_MPT_AMOUNT, TransferFee: 0, Flags: ISSUANCE_FLAGS,
            MPTokenMetadata: Buffer.from(JSON.stringify({ t: 'REGTEST', n: 'Regulated Test Token', d: 'Testnet compliance demonstration; no monetary value', ac: 'other' })).toString('hex').toUpperCase(),
        }, signer));
        const id = 'mpt_issuance_id' in receipt.metadata ? receipt.metadata.mpt_issuance_id : undefined;
        if (typeof id !== 'string')
            throw new Error(`Missing issuance ID in validated metadata: ${receipt.hash}`);
        const issuer = new MptIssuer(ledger, signer, id);
        await issuer.validateConfiguration();
        return issuer;
    }
    async issuance(ledgerHash) {
        const response = await this.ledger.client.request({ command: 'ledger_entry', mpt_issuance: this.issuanceId,
            ...(ledgerHash ? { ledger_hash: ledgerHash } : { ledger_index: 'validated' }) });
        const node = response.result.node;
        if (response.result.validated !== true || node?.LedgerEntryType !== 'MPTokenIssuance')
            throw new Error('Invalid issuance response');
        return node;
    }
    async validateConfiguration() {
        const node = await this.issuance();
        if (node.Issuer !== this.signer.address || (node.Flags & ~1) !== ISSUANCE_FLAGS ||
            (node.AssetScale ?? 0) !== 0 || (node.TransferFee ?? 0) !== 0 || node.DomainID) {
            throw new Error('Issuance does not match restricted compliance configuration');
        }
    }
    holder(address) {
        if (!isValidClassicAddress(address) || address === this.signer.address)
            throw new Error('Expected non-issuer classic holder address');
    }
    async state(address, ledgerHash) {
        this.holder(address);
        try {
            const response = await this.ledger.client.request({ command: 'ledger_entry',
                mptoken: { mpt_issuance_id: this.issuanceId, account: address },
                ...(ledgerHash ? { ledger_hash: ledgerHash } : { ledger_index: 'validated' }) });
            const node = response.result.node;
            if (response.result.validated !== true || node?.LedgerEntryType !== 'MPToken')
                throw new Error('Invalid holder response');
            return stateOf(node);
        }
        catch (error) {
            if (errorCode(error) !== 'entryNotFound')
                throw error;
            return { exists: false, balance: '0', authorized: false, frozen: false };
        }
    }
    banKey(address) { return `ban:${this.issuanceId}:${address}`; }
    async banStatus(address) { return this.ledger.store.get(this.banKey(address)); }
    async notBanned(address) {
        this.holder(address);
        if (await this.banStatus(address))
            throw new Error('Address is permanently banned by issuer policy');
    }
    async send(id, tx) {
        return requireSuccess(await this.ledger.transact(id, tx, this.signer));
    }
    authTx(address, revoke) {
        return { TransactionType: 'MPTokenAuthorize', Account: this.signer.address, MPTokenIssuanceID: this.issuanceId,
            Holder: address, Flags: revoke ? Authorize.tfMPTUnauthorize : 0 };
    }
    lockTx(frozen, address) {
        return { TransactionType: 'MPTokenIssuanceSet', Account: this.signer.address, MPTokenIssuanceID: this.issuanceId,
            Flags: frozen ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock, ...(address ? { Holder: address } : {}) };
    }
    async approve(address, id) {
        await this.ledger.exclusive(async () => {
            await this.notBanned(address);
            await this.validateConfiguration();
            await this.send(id, this.authTx(address, false));
            if (!(await this.state(address)).authorized)
                throw new Error('Authorization postcondition failed');
        });
    }
    async mint(address, value, id) {
        amount(value);
        await this.ledger.exclusive(async () => {
            await this.notBanned(address);
            await this.validateConfiguration();
            const state = await this.state(address);
            if (!state.authorized || state.frozen || ((await this.issuance()).Flags & 1))
                throw new Error('Mint blocked: unauthorized or frozen');
            await this.send(id, { TransactionType: 'Payment', Account: this.signer.address, Destination: address,
                Amount: { mpt_issuance_id: this.issuanceId, value } });
        });
    }
    async clawback(address, value, id) {
        this.holder(address);
        amount(value);
        await this.ledger.exclusive(async () => {
            await this.validateConfiguration();
            await this.send(id, { TransactionType: 'Clawback', Account: this.signer.address, Holder: address,
                Amount: { mpt_issuance_id: this.issuanceId, value } });
        });
    }
    async freezeHolder(address, frozen, id) {
        this.holder(address);
        await this.ledger.exclusive(async () => {
            if (!frozen)
                await this.notBanned(address);
            await this.validateConfiguration();
            await this.send(id, this.lockTx(frozen, address));
            if ((await this.state(address)).frozen !== frozen)
                throw new Error('Holder lock postcondition failed');
        });
    }
    async freezeGlobal(frozen, id) {
        await this.ledger.exclusive(async () => {
            await this.validateConfiguration();
            await this.send(id, this.lockTx(frozen));
            if (Boolean((await this.issuance()).Flags & 1) !== frozen)
                throw new Error('Global lock postcondition failed');
        });
    }
    /** Resumable saga: intent -> revoke -> lock -> drain -> verify. Never auto-unban. */
    async ban(address, reason, id) {
        this.holder(address);
        validateOperationId(`${id}:revoke`);
        if (!reason.trim())
            throw new Error('Ban requires an audit reason/reference');
        await this.ledger.exclusive(async () => {
            await this.validateConfiguration();
            const prior = await this.banStatus(address);
            if (prior && (prior.operationId !== id || prior.reason !== reason))
                throw new Error('Resume ban with original ID and reason');
            const ban = prior ?? { status: 'pending', reason, operationId: id };
            await this.ledger.store.set(this.banKey(address), ban);
            // Revocation prevents inbound payments even from issuer and survives deleting/recreating MPToken.
            if ((await this.state(address)).exists) {
                await this.send(`${id}:revoke`, this.authTx(address, true));
                await this.send(`${id}:lock`, this.lockTx(true, address));
                if (await this.ledger.store.get(`tx:${id}:drain`) || BigInt((await this.state(address)).balance) > 0n) {
                    await this.send(`${id}:drain`, { TransactionType: 'Clawback', Account: this.signer.address, Holder: address,
                        Amount: { mpt_issuance_id: this.issuanceId, value: MAX_MPT_AMOUNT } });
                }
            }
            const state = await this.state(address);
            if (state.balance !== '0' || state.authorized)
                throw new Error('Ban incomplete: holder still has value or authorization');
            await this.ledger.store.set(this.banKey(address), { ...ban, status: 'complete' });
        });
    }
}
function stateOf(node) {
    // rippled omits the default-valued MPTAmount field when balance is zero.
    // xrpl 5.3.0's MPToken declaration incorrectly marks that field as required.
    const balance = node.MPTAmount ?? '0';
    if (!/^(0|[1-9][0-9]*)$/.test(balance) || BigInt(balance) > BigInt(MAX_MPT_AMOUNT) || !Number.isInteger(node.Flags)) {
        throw new Error('Invalid holder amount or flags');
    }
    return { exists: true, balance, authorized: Boolean(node.Flags & HOLDER_AUTHORIZED), frozen: Boolean(node.Flags & HOLDER_LOCKED) };
}
//# sourceMappingURL=issuer.js.map