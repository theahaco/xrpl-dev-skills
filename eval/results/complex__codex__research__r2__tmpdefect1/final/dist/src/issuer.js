import { createHash } from 'node:crypto';
import { AccountSetAsfFlags, Client, Wallet, decodeAccountID, isValidClassicAddress, MPTokenIssuanceCreateFlags as CreateFlags, MPTokenIssuanceSetFlags as SetFlags, MPTokenAuthorizeFlags as AuthFlags } from 'xrpl';
import { Submitter, rpcCode } from './submitter.js';
export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export const MAX_AMOUNT = (2n ** 63n - 1n).toString();
export const CAPABILITIES = CreateFlags.tfMPTCanLock | CreateFlags.tfMPTRequireAuth |
    CreateFlags.tfMPTCanTransfer | CreateFlags.tfMPTCanClawback;
const AMENDMENTS = '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4';
export function amount(value) {
    if (!/^[1-9][0-9]*$/.test(value) || value.length > 19 || BigInt(value) > BigInt(MAX_AMOUNT))
        throw new Error('Amount must be a positive canonical integer <= 2^63-1');
    return value;
}
export function issuanceID(sequence, issuer) {
    const seq = Buffer.alloc(4);
    seq.writeUInt32BE(sequence);
    return Buffer.concat([seq, decodeAccountID(issuer)]).toString('hex').toUpperCase();
}
export async function assertTestnet(client) {
    const info = await client.request({ command: 'server_info' });
    if (info.result.info.network_id !== 1)
        throw new Error('This module only operates on XRPL testnet (network_id=1)');
    const a = await client.request({ command: 'ledger_entry', index: AMENDMENTS, ledger_index: 'validated' });
    if (!a.result.validated || a.result.node.LedgerEntryType !== 'Amendments')
        throw new Error('Cannot verify validated amendments');
    const active = a.result.node.Amendments ?? [];
    for (const name of ['MPTokensV1', 'Clawback', 'DepositAuth']) {
        const id = createHash('sha512').update(name).digest('hex').slice(0, 64).toUpperCase();
        if (!active.includes(id))
            throw new Error(`Required amendment disabled: ${name}`);
    }
    return { server: info.result.info, amendments: a.result };
}
/** Dedicated issuer: no deposit preauthorizations, escrow, trading or confidential balances.
 * All mutating methods serialize across the shared Submitter. Backend performs KYC before approve.
 */
export class MptIssuer {
    submitter;
    wallet;
    id;
    constructor(submitter, wallet, id) {
        this.submitter = submitter;
        this.wallet = wallet;
        this.id = id;
        if (!/^[A-F0-9]{48}$/.test(id))
            throw new Error('Invalid issuance ID');
        if (id.slice(8) !== Buffer.from(decodeAccountID(wallet.classicAddress)).toString('hex').toUpperCase())
            throw new Error('Issuance belongs to another issuer');
    }
    get address() { return this.wallet.classicAddress; }
    get client() { return this.submitter.client; }
    holderAddress(holder) {
        if (!isValidClassicAddress(holder) || holder === this.address)
            throw new Error('Expected non-issuer classic address');
    }
    notBanned(holder) {
        this.holderAddress(holder);
        if (this.submitter.store.isBanned(this.id, holder))
            throw new Error('Address is permanently banned by issuer policy');
    }
    static async create(submitter, wallet, operationId) {
        return submitter.exclusive(async () => {
            await assertTestnet(submitter.client);
            await submitter.send(`${operationId}:deposit-auth`, {
                TransactionType: 'AccountSet', Account: wallet.classicAddress, SetFlag: AccountSetAsfFlags.asfDepositAuth,
            }, wallet);
            const r = await submitter.send(`${operationId}:create`, {
                TransactionType: 'MPTokenIssuanceCreate', Account: wallet.classicAddress, Flags: CAPABILITIES,
                AssetScale: 0, MaximumAmount: '1000000000', TransferFee: 0,
            }, wallet);
            const issuer = new MptIssuer(submitter, wallet, issuanceID(r.sequence, wallet.classicAddress));
            await issuer.assertConfiguration();
            return issuer;
        });
    }
    async issuance(ledger = 'validated') {
        const r = await this.client.request({ command: 'ledger_entry', mpt_issuance: this.id, ledger_index: ledger });
        if (!r.result.validated || r.result.node.LedgerEntryType !== 'MPTokenIssuance')
            throw new Error('Invalid issuance response');
        return r.result.node;
    }
    async holder(holder, ledger = 'validated') {
        this.holderAddress(holder);
        try {
            const r = await this.client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: this.id, account: holder }, ledger_index: ledger });
            const n = r.result.node;
            // rippled omits zero-valued UInt64 fields in JSON, despite the SDK/docs marking this required.
            if (n['MPTAmount'] === undefined)
                n['MPTAmount'] = '0';
            if (!r.result.validated || n['LedgerEntryType'] !== 'MPToken' || n['Account'] !== holder || n['MPTokenIssuanceID'] !== this.id || typeof n['Flags'] !== 'number' || typeof n['MPTAmount'] !== 'string' || !/^[0-9]+$/.test(n['MPTAmount']))
                throw new Error('Invalid holder response');
            return n;
        }
        catch (e) {
            if (rpcCode(e) === 'entryNotFound')
                return undefined;
            throw e;
        }
    }
    async assertConfiguration() {
        await assertTestnet(this.client);
        const ledger = await this.client.getLedgerIndex();
        const [issuance, account, preauth] = await Promise.all([
            this.issuance(ledger),
            this.client.request({ command: 'account_info', account: this.address, ledger_index: ledger }),
            this.client.request({ command: 'account_objects', account: this.address, type: 'deposit_preauth', ledger_index: ledger }),
        ]);
        if (issuance.Issuer !== this.address || (issuance.Flags & ~1) !== CAPABILITIES || issuance.DomainID || (issuance.TransferFee ?? 0) !== 0 || (issuance.AssetScale ?? 0) !== 0)
            throw new Error('Unsupported issuance configuration');
        if (!(account.result.account_data.Flags & 0x01000000) || preauth.result.account_objects.length || preauth.result.marker)
            throw new Error('Strict freezes require issuer DepositAuth and no deposit preauthorizations');
    }
    approve(holder, operationId) {
        return this.submitter.exclusive(async () => {
            this.notBanned(holder);
            await this.assertConfiguration();
            if (!await this.holder(holder))
                throw new Error('Holder must first opt in using MPTokenAuthorize');
            await this.submitter.send(operationId, { TransactionType: 'MPTokenAuthorize', Account: this.address, MPTokenIssuanceID: this.id, Holder: holder }, this.wallet);
            if (!((await this.holder(holder)).Flags & 2))
                throw new Error('Authorization postcondition failed');
        });
    }
    issue(holder, value, operationId) {
        amount(value);
        return this.submitter.exclusive(async () => {
            this.notBanned(holder);
            await this.assertConfiguration();
            // Replay a completed operation without requiring that its historical preconditions still hold.
            if (!this.submitter.store.getTx(operationId)?.receipt) {
                const [i, h] = await Promise.all([this.issuance(), this.holder(holder)]);
                if (!h || !(h.Flags & 2) || (h.Flags & 1) || (i.Flags & 1))
                    throw new Error('Holder unauthorized or token frozen');
            }
            await this.submitter.send(operationId, { TransactionType: 'Payment', Account: this.address, Destination: holder,
                Amount: { mpt_issuance_id: this.id, value } }, this.wallet);
        });
    }
    clawback(holder, value, operationId) {
        this.holderAddress(holder);
        amount(value);
        return this.submitter.exclusive(async () => {
            await this.assertConfiguration();
            await this.submitter.send(operationId, { TransactionType: 'Clawback', Account: this.address, Holder: holder,
                Amount: { mpt_issuance_id: this.id, value } }, this.wallet);
        });
    }
    freezeHolder(holder, frozen, operationId) {
        this.holderAddress(holder);
        return this.submitter.exclusive(async () => {
            if (!frozen)
                this.notBanned(holder);
            await this.assertConfiguration();
            await this.lock(frozen, operationId, holder);
            if (Boolean((await this.holder(holder)).Flags & 1) !== frozen)
                throw new Error('Holder lock postcondition failed');
        });
    }
    freezeGlobal(frozen, operationId) {
        return this.submitter.exclusive(async () => {
            await this.assertConfiguration();
            await this.lock(frozen, operationId);
            if (Boolean((await this.issuance()).Flags & 1) !== frozen)
                throw new Error('Global lock postcondition failed');
        });
    }
    async lock(frozen, id, holder) {
        await this.submitter.send(id, { TransactionType: 'MPTokenIssuanceSet', Account: this.address, MPTokenIssuanceID: this.id,
            Flags: frozen ? SetFlags.tfMPTLock : SetFlags.tfMPTUnlock, ...(holder ? { Holder: holder } : {}) }, this.wallet);
    }
    /** Durable intent first; lock -> revoke -> drain -> verify. Retry with the SAME operation ID.
     * Not atomic. Failures leave the ban intent in force; never automatically restore authorization.
     */
    ban(holder, reason, operationId) {
        this.holderAddress(holder);
        if (!reason.trim())
            throw new Error('Ban requires an audit reason');
        return this.submitter.exclusive(async () => {
            this.submitter.store.ban(this.id, holder, reason);
            await this.assertConfiguration();
            let h = await this.holder(holder);
            if (!h)
                return; // Recreated entries require issuer approval, which persistent policy denies.
            await this.lock(true, `${operationId}:lock`, holder);
            await this.submitter.send(`${operationId}:revoke`, { TransactionType: 'MPTokenAuthorize', Account: this.address,
                MPTokenIssuanceID: this.id, Holder: holder, Flags: AuthFlags.tfMPTUnauthorize }, this.wallet);
            h = await this.holder(holder);
            // Use a constant drain amount so retry intent is stable even after a successful clawback.
            if (BigInt(h?.MPTAmount ?? '0') > 0n || this.submitter.store.getTx(`${operationId}:drain`)) {
                await this.submitter.send(`${operationId}:drain`, { TransactionType: 'Clawback', Account: this.address, Holder: holder,
                    Amount: { mpt_issuance_id: this.id, value: MAX_AMOUNT } }, this.wallet);
            }
            h = await this.holder(holder);
            if (h && (BigInt(h.MPTAmount) !== 0n || (h.Flags & 2)))
                throw new Error('Ban postcondition failed');
        });
    }
}
