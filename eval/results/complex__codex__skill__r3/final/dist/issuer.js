import { isValidClassicAddress, MPTokenIssuanceCreateFlags as CreateFlags, MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags as AuthFlags, } from 'xrpl';
import { SerialQueue } from './state.js';
import { rpcError } from './transactions.js';
export const MAX_AMOUNT = 9223372036854775807n;
export const REQUIRED_FLAGS = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
    CreateFlags.tfMPTCanClawback | CreateFlags.tfMPTCanTransfer;
export function amount(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > MAX_AMOUNT)
        throw new Error('Amount must be a positive canonical integer string <= 2^63-1');
    return value;
}
export function address(value) {
    if (!isValidClassicAddress(value))
        throw new Error('Invalid classic address');
    return value;
}
export function issuanceId(value) {
    if (!/^[A-Fa-f0-9]{48}$/.test(value))
        throw new Error('Invalid MPT issuance ID');
    return value.toUpperCase();
}
export function tokenPayment(id, from, to, value) {
    if (from === to)
        throw new Error('Payment source and destination must differ');
    return { TransactionType: 'Payment', Account: address(from), Destination: address(to), Amount: { mpt_issuance_id: issuanceId(id), value: amount(value) } };
}
/** Amounts are integer ledger units; AssetScale is display metadata, never floating-point arithmetic. */
export class MptIssuer {
    runner;
    signer;
    id;
    queue = new SerialQueue();
    constructor(runner, signer, id) {
        this.runner = runner;
        this.signer = signer;
        this.id = id;
    }
    get account() { return this.signer.classicAddress; }
    static async create(runner, signer, operation, options) {
        address(signer.classicAddress);
        const scale = options.assetScale ?? 0;
        if (!Number.isInteger(scale) || scale < 0 || scale > 255)
            throw new Error('Invalid asset scale');
        const receipt = await runner.send(operation, {
            TransactionType: 'MPTokenIssuanceCreate', Account: signer.classicAddress,
            Flags: REQUIRED_FLAGS, AssetScale: scale, MaximumAmount: amount(options.maximumAmount), TransferFee: 0,
        }, signer);
        const meta = receipt.meta;
        if (!('mpt_issuance_id' in meta) || typeof meta.mpt_issuance_id !== 'string')
            throw new Error(`Missing issuance ID in validated creation metadata: ${receipt.hash}`);
        return MptIssuer.connect(runner, signer, meta.mpt_issuance_id);
    }
    static async connect(runner, signer, id) {
        const issuer = new MptIssuer(runner, signer, issuanceId(id));
        const entry = await issuer.issuance();
        if (entry.Issuer !== signer.classicAddress || (entry.Flags & REQUIRED_FLAGS) !== REQUIRED_FLAGS)
            throw new Error('Wrong issuer or required capabilities missing');
        // This module deliberately excludes escrow, trading, confidential balances and domain authorization.
        if ((entry.Flags & (8 | 16 | 128)) !== 0 || entry.DomainID)
            throw new Error('Unsupported token policy');
        return issuer;
    }
    async issuance(ledgerHash) {
        const response = await this.runner.client.request({ command: 'ledger_entry', mpt_issuance: this.id,
            ...(ledgerHash ? { ledger_hash: ledgerHash } : { ledger_index: 'validated' }) });
        if (!response.result.validated || response.result.node?.LedgerEntryType !== 'MPTokenIssuance')
            throw new Error('Invalid issuance response');
        return response.result.node;
    }
    async holder(holder, ledgerHash) {
        this.checkHolder(holder);
        try {
            const response = await this.runner.client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: this.id, account: holder },
                ...(ledgerHash ? { ledger_hash: ledgerHash } : { ledger_index: 'validated' }) });
            if (!response.result.validated || response.result.node?.LedgerEntryType !== 'MPToken')
                throw new Error('Invalid holder response');
            return response.result.node;
        }
        catch (error) {
            if (rpcError(error, 'entryNotFound'))
                return undefined;
            throw error;
        }
    }
    checkHolder(holder) {
        address(holder);
        if (holder === this.account)
            throw new Error('Issuer cannot be a holder');
    }
    banKey(holder) { return `${this.id}:${holder}`; }
    allowed(holder) {
        this.checkHolder(holder);
        if (this.runner.store.data.bans[this.banKey(holder)])
            throw new Error('Holder is permanently banned by issuer policy');
    }
    approve(holder, operation) {
        return this.queue.run(async () => {
            this.allowed(holder);
            return this.runner.send(operation, { TransactionType: 'MPTokenAuthorize', Account: this.account, MPTokenIssuanceID: this.id, Holder: holder }, this.signer);
        });
    }
    mint(holder, value, operation) {
        return this.queue.run(async () => {
            this.allowed(holder);
            const [holding, issuance] = await Promise.all([this.holder(holder), this.issuance()]);
            if (!holding || !(holding.Flags & 2) || (holding.Flags & 1) || (issuance.Flags & 1))
                throw new Error('Holder unauthorized or token frozen');
            return this.runner.send(operation, tokenPayment(this.id, this.account, holder, value), this.signer);
        });
    }
    clawback(holder, value, operation) {
        return this.queue.run(() => this.clawbackInternal(holder, value, operation));
    }
    clawbackInternal(holder, value, operation) {
        this.checkHolder(holder);
        return this.runner.send(operation, { TransactionType: 'Clawback', Account: this.account, Holder: holder,
            Amount: { mpt_issuance_id: this.id, value: amount(value) } }, this.signer);
    }
    freezeHolder(holder, operation) {
        return this.queue.run(() => { this.checkHolder(holder); return this.lock(true, operation, holder); });
    }
    unfreezeHolder(holder, operation) {
        return this.queue.run(() => { this.allowed(holder); return this.lock(false, operation, holder); });
    }
    freezeAll(operation) { return this.queue.run(() => this.lock(true, operation)); }
    unfreezeAll(operation) { return this.queue.run(() => this.lock(false, operation)); }
    lock(locked, operation, holder) {
        return this.runner.send(operation, { TransactionType: 'MPTokenIssuanceSet', Account: this.account,
            MPTokenIssuanceID: this.id, Flags: locked ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock,
            ...(holder ? { Holder: holder } : {}) }, this.signer);
    }
    /** Restartable, fail-closed workflow: persist intent -> revoke auth -> claw back -> verify.
     * Revocation fences incoming funds even if holder deletes/recreates its holding.
     * Redemption to issuer can race the clawback; it only reduces the balance further.
     */
    ban(holder, reason, operation) {
        return this.queue.run(async () => {
            this.checkHolder(holder);
            if (!reason.trim())
                throw new Error('Ban requires an audit reason/reference');
            const key = this.banKey(holder);
            this.runner.store.data.bans[key] ??= { reason, startedAt: new Date().toISOString(), complete: false };
            await this.runner.store.save();
            const revokeId = `${operation}/revoke`;
            if (await this.holder(holder) || this.runner.store.data.transactions[revokeId]) {
                await this.runner.send(revokeId, { TransactionType: 'MPTokenAuthorize', Account: this.account,
                    MPTokenIssuanceID: this.id, Holder: holder, Flags: AuthFlags.tfMPTUnauthorize }, this.signer);
            }
            const clawId = `${operation}/clawback`;
            if (BigInt((await this.holder(holder))?.MPTAmount ?? '0') > 0n || this.runner.store.data.transactions[clawId]) {
                // Protocol caps this at the holder's balance. MAX avoids a stale-read under-clawback.
                try {
                    await this.clawbackInternal(holder, MAX_AMOUNT.toString(), clawId);
                }
                catch (error) {
                    // Only accept a validated zero-balance race, never an uncertain network outcome.
                    const receipt = this.runner.store.data.transactions[clawId]?.receipt;
                    if (receipt?.code !== 'tecNO_LINE')
                        throw error;
                }
            }
            const final = await this.holder(holder);
            if (final && (BigInt(final.MPTAmount ?? '0') !== 0n || (final.Flags & 2)))
                throw new Error('Ban incomplete; retry same operation ID');
            this.runner.store.data.bans[key].complete = true;
            await this.runner.store.save();
        });
    }
}
