import { AccountSetAsfFlags, MPTokenIssuanceCreateFlags as CreateFlags, MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags, isValidClassicAddress, convertStringToHex, } from 'xrpl';
import { Ledger, requireSuccess } from './ledger.js';
export const CAPABILITIES = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
    CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
export const MAX_AMOUNT = (2n ** 63n - 1n).toString();
export function amount(value) {
    if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_AMOUNT))
        throw new Error('Amount must be a positive integer string <= 2^63-1 (base units)');
    return value;
}
export function holderAddress(value, issuer) {
    if (!isValidClassicAddress(value) || value === issuer)
        throw new Error('Expected a non-issuer classic address');
    return value;
}
export function creation(account, maximum, scale) {
    if (!Number.isInteger(scale) || scale < 0 || scale > 255)
        throw new Error('AssetScale must be 0..255');
    return { TransactionType: 'MPTokenIssuanceCreate', Account: account, Flags: CAPABILITIES,
        AssetScale: scale, MaximumAmount: amount(maximum), TransferFee: 0,
        MPTokenMetadata: convertStringToHex(JSON.stringify({ t: 'REGTEST', n: 'Regulated test token', d: 'Testnet demonstration; no monetary value', ac: 'other' })) };
}
/** KYC is off-ledger. DepositAuth with NO preauthorizations closes the lock redemption exception. */
export class MptIssuer {
    ledger;
    signer;
    issuanceId;
    constructor(ledger, signer, issuanceId) {
        this.ledger = ledger;
        this.signer = signer;
        this.issuanceId = issuanceId;
        if (!/^[0-9A-F]{48}$/.test(issuanceId))
            throw new Error('Invalid MPT issuance ID');
    }
    get address() { return this.signer.classicAddress; }
    static async create(ledger, signer, id, maximum = '1000000000', scale = 0) {
        return ledger.serial(async () => {
            await ledger.preflight();
            requireSuccess(await ledger.send(`${id}:deposit-auth`, signer, { TransactionType: 'AccountSet', Account: signer.classicAddress, SetFlag: AccountSetAsfFlags.asfDepositAuth }));
            const response = await ledger.send(id, signer, creation(signer.classicAddress, maximum, scale));
            requireSuccess(response);
            if (typeof response.meta !== 'object' || !('mpt_issuance_id' in response.meta) || typeof response.meta.mpt_issuance_id !== 'string')
                throw new Error('Missing validated MPT issuance id');
            const instance = new MptIssuer(ledger, signer, response.meta.mpt_issuance_id);
            await instance.assertProfile();
            return instance;
        });
    }
    async issuance(ledgerHash) {
        const node = await this.ledger.entry({ mpt_issuance: this.issuanceId, ...(ledgerHash ? { ledger_hash: ledgerHash } : {}) });
        if (node?.LedgerEntryType !== 'MPTokenIssuance' || node.Issuer !== this.address)
            throw new Error('Issuance does not belong to signer');
        return node;
    }
    async holder(holder, ledgerHash) {
        holderAddress(holder, this.address);
        const node = await this.ledger.entry({ mptoken: { mpt_issuance_id: this.issuanceId, account: holder }, ...(ledgerHash ? { ledger_hash: ledgerHash } : {}) });
        if (node && node.LedgerEntryType !== 'MPToken')
            throw new Error('Wrong ledger object');
        // rippled omits default-valued UInt64 fields, despite the SDK marking MPTAmount required.
        return node ? { ...node, MPTAmount: node.MPTAmount ?? '0' } : undefined;
    }
    async assertProfile() {
        await this.ledger.preflight();
        const issuance = await this.issuance();
        if ((issuance.Flags & ~1) !== CAPABILITIES || issuance.DomainID || (issuance.TransferFee ?? 0) !== 0)
            throw new Error('Unsafe issuance capabilities');
        const info = await this.ledger.client.request({ command: 'account_info', account: this.address, ledger_index: 'validated' });
        if (!(info.result.account_data.Flags & 0x01000000))
            throw new Error('Issuer DepositAuth must remain enabled');
        let marker;
        do {
            const response = await this.ledger.client.request({ command: 'account_objects', account: this.address, ledger_index: 'validated', type: 'deposit_preauth', ...(marker ? { marker } : {}) });
            if (response.result.account_objects.length)
                throw new Error('Issuer preauthorizations would bypass redemption protection');
            marker = response.result.marker;
        } while (marker);
    }
    allowed(holder) {
        holderAddress(holder, this.address);
        if (this.ledger.journal.banned(this.issuanceId, holder))
            throw new Error('Address is permanently banned by issuer policy');
    }
    async setLock(id, locked, holder) {
        requireSuccess(await this.ledger.send(id, this.signer, { TransactionType: 'MPTokenIssuanceSet', Account: this.address,
            MPTokenIssuanceID: this.issuanceId, Flags: locked ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock, ...(holder ? { Holder: holder } : {}) }));
    }
    approve(id, holder, kycReference) {
        return this.ledger.serial(async () => {
            this.allowed(holder);
            if (!kycReference.trim())
                throw new Error('KYC approval reference required');
            await this.assertProfile();
            this.ledger.journal.set(`kyc:${this.issuanceId}:${holder}`, kycReference);
            requireSuccess(await this.ledger.send(id, this.signer, { TransactionType: 'MPTokenAuthorize', Account: this.address, MPTokenIssuanceID: this.issuanceId, Holder: holder }));
        });
    }
    mint(id, holder, value) {
        return this.ledger.serial(async () => {
            this.allowed(holder);
            amount(value);
            await this.assertProfile();
            const [issuance, state] = await Promise.all([this.issuance(), this.holder(holder)]);
            if ((issuance.Flags & 1) || !state || !(state.Flags & 2) || (state.Flags & 1))
                throw new Error('Recipient must be authorized and unlocked; issuance must be unlocked');
            requireSuccess(await this.ledger.send(id, this.signer, this.payment(this.address, holder, value)));
        });
    }
    payment(sender, destination, value) {
        if (!isValidClassicAddress(sender) || !isValidClassicAddress(destination))
            throw new Error('Invalid classic address');
        return { TransactionType: 'Payment', Account: sender, Destination: destination, Amount: { mpt_issuance_id: this.issuanceId, value: amount(value) } };
    }
    clawback(id, holder, value) {
        return this.ledger.serial(async () => {
            holderAddress(holder, this.address);
            amount(value);
            await this.assertProfile();
            requireSuccess(await this.ledger.send(id, this.signer, { TransactionType: 'Clawback', Account: this.address, Holder: holder, Amount: { mpt_issuance_id: this.issuanceId, value } }));
        });
    }
    freeze(id, holder, locked = true) {
        return this.ledger.serial(async () => {
            holderAddress(holder, this.address);
            if (!locked)
                this.allowed(holder);
            await this.assertProfile();
            await this.setLock(id, locked, holder);
        });
    }
    globalFreeze(id, locked = true) {
        return this.ledger.serial(async () => { await this.assertProfile(); await this.setLock(id, locked); });
    }
    /** Resumable saga: durable ban -> revoke -> lock -> drain -> verify. Completion guarantees zero.
     * Escrow, trading and confidential balances are disabled by this issuance profile.
     */
    ban(id, holder, reason) {
        return this.ledger.serial(async () => {
            holderAddress(holder, this.address);
            if (!reason.trim())
                throw new Error('Ban reason/reference required');
            this.ledger.journal.ban(this.issuanceId, holder, reason);
            await this.assertProfile();
            let state = await this.holder(holder);
            if (!state)
                return;
            requireSuccess(await this.ledger.send(`${id}:revoke`, this.signer, { TransactionType: 'MPTokenAuthorize', Account: this.address, MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize }));
            await this.setLock(`${id}:lock`, true, holder);
            state = await this.holder(holder);
            const priorDrain = this.ledger.journal.db.prepare('SELECT id FROM tx WHERE id=?').get(`${id}:drain`);
            if (priorDrain || (state && BigInt(state.MPTAmount) > 0n)) {
                requireSuccess(await this.ledger.send(`${id}:drain`, this.signer, { TransactionType: 'Clawback', Account: this.address, Holder: holder, Amount: { mpt_issuance_id: this.issuanceId, value: MAX_AMOUNT } }));
            }
            state = await this.holder(holder);
            if (state && (state.MPTAmount !== '0' || (state.Flags & 2)))
                throw new Error('Ban incomplete: balance or authorization remains');
        });
    }
}
