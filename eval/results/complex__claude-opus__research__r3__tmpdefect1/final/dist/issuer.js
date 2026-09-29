/**
 * Issuer-side controls for a regulated, stablecoin-style Multi-Purpose Token
 * (XLS-33) on the XRP Ledger.
 *
 * Controls and how they map onto the protocol:
 *
 * | Control           | Ledger mechanism                                                   |
 * | ----------------- | ------------------------------------------------------------------ |
 * | Allowlist         | lsfMPTRequireAuth + MPTokenAuthorize (issuer, Holder)               |
 * | Clawback          | lsfMPTCanClawback + Clawback (Holder)                              |
 * | Per-holder freeze | lsfMPTCanLock + MPTokenIssuanceSet tfMPTLock/tfMPTUnlock (Holder)  |
 * | Global freeze     | lsfMPTCanLock + MPTokenIssuanceSet tfMPTLock/tfMPTUnlock           |
 * | Ban               | ban store + lock + claw back entire balance + revoke authorization |
 *
 * Capability flags can only be set when the issuance is created while the
 * DynamicMPT amendment is not enabled (as on testnet and mainnet at the time
 * of writing), so `createIssuance` always sets every flag the controls need,
 * and `open` refuses to manage an issuance that is missing any of them.
 *
 * Operations on one `MptIssuer` instance are serialized, so the
 * read-check-submit sequence inside each operation can't interleave with
 * another operation from the same process. Run a single instance per issuer
 * account; independent processes signing for the same account will race on
 * the account Sequence.
 */
import { MPTokenAuthorizeFlags, MPTokenIssuanceCreateFlags, MPTokenIssuanceSetFlags, encodeMPTokenMetadata, isValidClassicAddress, } from 'xrpl';
import { MAX_MPT_AMOUNT, assertAssetScale, fromRawAmount, parseRawAmount, toRawAmount } from './amounts.js';
import { ComplianceError, IssuerError, PreconditionError, VerificationError } from './errors.js';
import { MPTokenFlags, accountExists, fetchIssuance, fetchMPToken, submitTransaction, } from './ledger.js';
/** Flags every issuance managed by this module must have. */
export const REQUIRED_ISSUANCE_FLAGS = MPTokenIssuanceCreateFlags.tfMPTRequireAuth | // allowlist
    MPTokenIssuanceCreateFlags.tfMPTCanClawback | // clawback / ban
    MPTokenIssuanceCreateFlags.tfMPTCanLock | // per-holder and global freeze
    MPTokenIssuanceCreateFlags.tfMPTCanTransfer; // holders can pay each other (so freezes are meaningful)
// Deliberately NOT set:
// - tfMPTCanEscrow: escrowed balances move out of the holder's spendable
//   balance, and a ban must be able to claw back everything the holder has.
// - tfMPTCanTrade: MPT DEX trading is not implemented on the ledger yet.
const LSF_MPT_LOCKED = 0x00000001; // MPTokenIssuance global lock flag
const silentLogger = { info: () => { }, warn: () => { } };
export class MptIssuer {
    issuanceId;
    assetScale;
    #client;
    #wallet;
    #banStore;
    #logger;
    #queue = Promise.resolve();
    constructor(client, wallet, issuanceId, assetScale, options) {
        this.issuanceId = issuanceId;
        this.assetScale = assetScale;
        this.#client = client;
        this.#wallet = wallet;
        this.#banStore = options.banStore;
        this.#logger = options.logger ?? silentLogger;
    }
    get issuerAddress() {
        return this.#wallet.classicAddress;
    }
    /** Create a new issuance with every compliance control enabled, and return a manager for it. */
    static async createIssuance(client, wallet, issuance, options) {
        const assetScale = issuance.assetScale ?? 0;
        assertAssetScale(assetScale);
        const maximumAmount = issuance.maximumAmount === undefined ? undefined : toRawAmount(issuance.maximumAmount, assetScale);
        const tx = await submitTransaction(client, wallet, {
            TransactionType: 'MPTokenIssuanceCreate',
            Account: wallet.classicAddress,
            Flags: REQUIRED_ISSUANCE_FLAGS,
            AssetScale: assetScale,
            ...(maximumAmount === undefined ? {} : { MaximumAmount: maximumAmount.toString() }),
            ...(issuance.metadata === undefined ? {} : { MPTokenMetadata: encodeMPTokenMetadata(issuance.metadata) }),
        });
        const issuanceId = tx.meta.mpt_issuance_id;
        if (issuanceId === undefined) {
            throw new VerificationError(`MPTokenIssuanceCreate ${tx.hash} validated without an mpt_issuance_id`);
        }
        options.logger?.info('issuance created', { issuanceId, hash: tx.hash, flags: REQUIRED_ISSUANCE_FLAGS });
        return MptIssuer.open(client, wallet, issuanceId, options);
    }
    /** Manage an existing issuance. Verifies the wallet is its issuer and that every control is available. */
    static async open(client, wallet, issuanceId, options) {
        const issuance = await fetchIssuance(client, issuanceId);
        if (issuance === undefined) {
            throw new PreconditionError(`MPT issuance ${issuanceId} not found in the validated ledger`);
        }
        if (issuance.Issuer !== wallet.classicAddress) {
            throw new PreconditionError(`Issuance ${issuanceId} is issued by ${issuance.Issuer}, not by the signing wallet ${wallet.classicAddress}`);
        }
        const missing = REQUIRED_ISSUANCE_FLAGS & ~issuance.Flags;
        if (missing !== 0) {
            throw new PreconditionError(`Issuance ${issuanceId} lacks required capability flags (missing 0x${missing.toString(16)})`);
        }
        return new MptIssuer(client, wallet, issuanceId, issuance.AssetScale ?? 0, options);
    }
    // ---------------------------------------------------------------- queries
    async getIssuance() {
        const issuance = await this.#requireIssuance();
        return {
            issuanceId: this.issuanceId,
            issuer: issuance.Issuer,
            assetScale: this.assetScale,
            outstandingAmount: fromRawAmount(parseRawAmount(issuance.OutstandingAmount), this.assetScale),
            maximumAmount: issuance.MaximumAmount === undefined
                ? undefined
                : fromRawAmount(parseRawAmount(issuance.MaximumAmount), this.assetScale),
            globallyFrozen: (issuance.Flags & LSF_MPT_LOCKED) !== 0,
            flags: issuance.Flags,
        };
    }
    async getHolder(address) {
        assertAddress(address);
        const [token, banned] = await Promise.all([
            fetchMPToken(this.#client, this.issuanceId, address),
            this.#banStore.isBanned(address),
        ]);
        return this.#holderState(address, token, banned);
    }
    async isBanned(address) {
        return this.#banStore.isBanned(address);
    }
    async listBans() {
        return this.#banStore.list();
    }
    // --------------------------------------------------------------- allowlist
    /**
     * Approve a KYC'd holder. The holder must first opt in by submitting their
     * own MPTokenAuthorize, which creates their MPToken entry.
     */
    async authorizeHolder(address) {
        return this.#exclusive(async () => {
            const holder = await this.#holderForUpdate(address);
            if (holder.banned) {
                throw new ComplianceError(`${address} is banned and cannot be authorized`);
            }
            if (!holder.optedIn) {
                throw new PreconditionError(`${address} has not opted in to ${this.issuanceId}; they must submit MPTokenAuthorize first`);
            }
            if (holder.authorized) {
                return unchanged();
            }
            const tx = await this.#submit({
                TransactionType: 'MPTokenAuthorize',
                Account: this.issuerAddress,
                MPTokenIssuanceID: this.issuanceId,
                Holder: address,
            });
            await this.#expectHolder(address, (h) => h.authorized, 'authorized');
            this.#logger.info('holder authorized', { holder: address, hash: tx.hash });
            return changed(tx);
        });
    }
    /**
     * Revoke a holder's approval (e.g. expired KYC). They keep any balance they
     * hold but can no longer receive or send the token. Use `ban` to also
     * remove their balance.
     */
    async revokeAuthorization(address) {
        return this.#exclusive(async () => {
            const holder = await this.#holderForUpdate(address);
            if (!holder.optedIn || !holder.authorized) {
                return unchanged();
            }
            const tx = await this.#revoke(address);
            return changed(tx);
        });
    }
    // ---------------------------------------------------------------- issuing
    /** Issue (mint) `amount` display units of the token to an approved holder. */
    async issue(address, amount) {
        const raw = toRawAmount(amount, this.assetScale);
        return this.#exclusive(async () => {
            const holder = await this.#holderForUpdate(address);
            if (holder.banned) {
                throw new ComplianceError(`${address} is banned and cannot receive the token`);
            }
            if (!holder.optedIn || !holder.authorized) {
                throw new ComplianceError(`${address} is not an approved holder`);
            }
            if (holder.frozen) {
                throw new PreconditionError(`${address} is frozen`);
            }
            const issuance = await this.getIssuance();
            if (issuance.globallyFrozen) {
                throw new PreconditionError(`${this.issuanceId} is globally frozen`);
            }
            const tx = await this.#submit({
                TransactionType: 'Payment',
                Account: this.issuerAddress,
                Destination: address,
                // No tfPartialPayment: the payment either delivers the full amount or fails.
                Amount: this.#mptAmount(raw),
            });
            const delivered = tx.meta.delivered_amount;
            if (!isMptAmount(delivered) || delivered.mpt_issuance_id !== this.issuanceId || BigInt(delivered.value) !== raw) {
                throw new VerificationError(`Payment ${tx.hash} delivered ${JSON.stringify(delivered)}, expected ${raw}`);
            }
            this.#logger.info('tokens issued', { holder: address, amount, hash: tx.hash });
            return changed(tx);
        });
    }
    // --------------------------------------------------------------- clawback
    /**
     * Claw back `amount` display units, or `'all'` of the holder's balance.
     * Works regardless of whether the holder is frozen or still authorized.
     */
    async clawback(address, amount) {
        const requested = amount === 'all' ? undefined : toRawAmount(amount, this.assetScale);
        return this.#exclusive(async () => {
            const holder = await this.#holderForUpdate(address);
            return this.#clawback(holder, requested);
        });
    }
    // ---------------------------------------------------------------- freezes
    /**
     * Freeze one holder: the ledger stops them sending the token to, or
     * receiving it from, other holders (they can still send it back to the
     * issuer). The ledger does NOT stop the issuer paying a frozen holder;
     * `issue` refuses to, so always issue through this module.
     */
    async freezeHolder(address) {
        return this.#setHolderFrozen(address, true);
    }
    async unfreezeHolder(address) {
        return this.#setHolderFrozen(address, false);
    }
    /** Freeze all movement of the token between holders. `issue` also refuses to mint while frozen. */
    async freezeAll() {
        return this.#setGloballyFrozen(true);
    }
    async unfreezeAll() {
        return this.#setGloballyFrozen(false);
    }
    // -------------------------------------------------------------------- ban
    /**
     * Ban an address: record the ban, freeze the holder, claw back their entire
     * balance and revoke their authorization. Afterwards the address holds none
     * of the token and the ledger rejects any payment to it; the ban store
     * stops this module from ever re-approving it.
     *
     * Idempotent: if any step fails, calling `ban` again resumes where it stopped.
     */
    async ban(address, reason) {
        return this.#exclusive(async () => {
            assertAddress(address);
            if (address === this.issuerAddress) {
                throw new ComplianceError('The issuer cannot ban itself');
            }
            // Record first, so no concurrent approval/issuance can slip in while the
            // ledger steps are in flight.
            await this.#banStore.add({ address, reason, bannedAt: new Date().toISOString() });
            const record = await this.#banStore.get(address);
            if (record === undefined) {
                throw new IssuerError(`Ban store did not persist the ban for ${address}`);
            }
            this.#logger.warn('holder banned', { holder: address, reason: record.reason });
            const transactions = [];
            let holder = await this.getHolder(address);
            if (!holder.optedIn) {
                // No MPToken entry: they hold nothing and, because the issuance
                // requires authorization, can only ever hold it if we approve them,
                // which the ban store now prevents.
                return { changed: true, transactions, clawedBack: fromRawAmount(0n, this.assetScale), record };
            }
            // 1. Freeze, so the balance cannot move while we claw it back.
            if (!holder.frozen) {
                transactions.push(await this.#lockHolder(address, true));
            }
            // 2. Claw back everything.
            const clawback = await this.#clawback(holder, undefined);
            transactions.push(...clawback.transactions);
            // 3. Revoke approval, so the ledger itself rejects future payments. The
            //    lock alone is not enough: it doesn't stop issuer payments.
            holder = await this.getHolder(address);
            if (holder.authorized) {
                transactions.push(await this.#revoke(address));
            }
            const final = await this.getHolder(address);
            if (final.rawBalance !== 0n || final.authorized || !final.frozen) {
                throw new VerificationError(`Ban of ${address} incomplete: ${JSON.stringify(serializable(final))}`);
            }
            return { changed: transactions.length > 0, transactions, clawedBack: clawback.clawedBack, record };
        });
    }
    // ---------------------------------------------------------------- helpers
    /** Run `operation` after every previously queued operation has settled. */
    #exclusive(operation) {
        const run = this.#queue.then(operation, operation);
        this.#queue = run.catch(() => undefined);
        return run;
    }
    #submit(transaction) {
        return submitTransaction(this.#client, this.#wallet, transaction);
    }
    #mptAmount(raw) {
        return { mpt_issuance_id: this.issuanceId, value: raw.toString() };
    }
    async #requireIssuance() {
        const issuance = await fetchIssuance(this.#client, this.issuanceId);
        if (issuance === undefined) {
            throw new PreconditionError(`MPT issuance ${this.issuanceId} no longer exists`);
        }
        return issuance;
    }
    async #holderForUpdate(address) {
        assertAddress(address);
        if (address === this.issuerAddress) {
            throw new PreconditionError('The issuer cannot be a holder of its own token');
        }
        const holder = await this.getHolder(address);
        if (!holder.optedIn && !(await accountExists(this.#client, address))) {
            throw new PreconditionError(`Account ${address} does not exist on this network`);
        }
        return holder;
    }
    #holderState(address, token, banned) {
        const rawBalance = parseRawAmount(token?.MPTAmount);
        const flags = token?.Flags ?? 0;
        return {
            address,
            optedIn: token !== undefined,
            balance: fromRawAmount(rawBalance, this.assetScale),
            rawBalance,
            authorized: (flags & MPTokenFlags.lsfMPTAuthorized) !== 0,
            frozen: (flags & MPTokenFlags.lsfMPTLocked) !== 0,
            banned,
        };
    }
    async #expectHolder(address, predicate, description) {
        const holder = await this.getHolder(address);
        if (!predicate(holder)) {
            throw new VerificationError(`Expected ${address} to be ${description}; ledger shows ${JSON.stringify(serializable(holder))}`);
        }
    }
    async #revoke(address) {
        const tx = await this.#submit({
            TransactionType: 'MPTokenAuthorize',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Holder: address,
            Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
        });
        await this.#expectHolder(address, (h) => !h.authorized, 'unauthorized');
        this.#logger.info('holder authorization revoked', { holder: address, hash: tx.hash });
        return tx;
    }
    async #clawback(holder, requested) {
        if (!holder.optedIn) {
            throw new PreconditionError(`${holder.address} does not hold ${this.issuanceId}`);
        }
        if (holder.rawBalance === 0n) {
            if (requested === undefined) {
                return { ...unchanged(), clawedBack: fromRawAmount(0n, this.assetScale) };
            }
            throw new PreconditionError(`${holder.address} has a zero balance`);
        }
        if (requested !== undefined && requested > holder.rawBalance) {
            throw new PreconditionError(`Cannot claw back ${fromRawAmount(requested, this.assetScale)} from ${holder.address}: balance is ${holder.balance}`);
        }
        // For 'all', request the protocol maximum: the ledger claws back the
        // entire balance when the amount exceeds it, even if the balance changed
        // since we read it.
        const amount = requested ?? MAX_MPT_AMOUNT;
        const tx = await this.#submit({
            TransactionType: 'Clawback',
            Account: this.issuerAddress,
            Amount: this.#mptAmount(amount),
            Holder: holder.address,
        });
        const removed = clawedBackFromMeta(tx.meta, this.issuanceId, holder.address);
        const clawedBack = fromRawAmount(removed, this.assetScale);
        this.#logger.info('tokens clawed back', { holder: holder.address, amount: clawedBack, hash: tx.hash });
        return { changed: true, transactions: [tx], clawedBack };
    }
    async #setHolderFrozen(address, frozen) {
        return this.#exclusive(async () => {
            const holder = await this.#holderForUpdate(address);
            if (!holder.optedIn) {
                throw new PreconditionError(`${address} does not hold ${this.issuanceId}; there is nothing to freeze`);
            }
            if (holder.frozen === frozen) {
                return unchanged();
            }
            return changed(await this.#lockHolder(address, frozen));
        });
    }
    async #lockHolder(address, frozen) {
        const tx = await this.#submit({
            TransactionType: 'MPTokenIssuanceSet',
            Account: this.issuerAddress,
            MPTokenIssuanceID: this.issuanceId,
            Holder: address,
            Flags: frozen ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
        });
        await this.#expectHolder(address, (h) => h.frozen === frozen, frozen ? 'frozen' : 'unfrozen');
        this.#logger.info(frozen ? 'holder frozen' : 'holder unfrozen', { holder: address, hash: tx.hash });
        return tx;
    }
    async #setGloballyFrozen(frozen) {
        return this.#exclusive(async () => {
            if ((await this.getIssuance()).globallyFrozen === frozen) {
                return unchanged();
            }
            const tx = await this.#submit({
                TransactionType: 'MPTokenIssuanceSet',
                Account: this.issuerAddress,
                MPTokenIssuanceID: this.issuanceId,
                Flags: frozen ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
            });
            if ((await this.getIssuance()).globallyFrozen !== frozen) {
                throw new VerificationError(`Global freeze of ${this.issuanceId} did not become ${frozen}`);
            }
            this.#logger.warn(frozen ? 'token globally frozen' : 'global freeze lifted', { hash: tx.hash });
            return changed(tx);
        });
    }
}
function changed(tx) {
    return { changed: true, transactions: [tx] };
}
function unchanged() {
    return { changed: false, transactions: [] };
}
function assertAddress(address) {
    if (!isValidClassicAddress(address)) {
        throw new PreconditionError(`Not a valid classic address: ${address}`);
    }
}
function isMptAmount(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof value.mpt_issuance_id === 'string' &&
        typeof value.value === 'string');
}
/** Balance reduction of the holder's MPToken in a validated Clawback's metadata. */
export function clawedBackFromMeta(meta, issuanceId, holder) {
    for (const node of meta.AffectedNodes) {
        if (!('ModifiedNode' in node) || node.ModifiedNode.LedgerEntryType !== 'MPToken') {
            continue;
        }
        const { FinalFields: final, PreviousFields: previous } = node.ModifiedNode;
        if (final?.['Account'] !== holder || final['MPTokenIssuanceID'] !== issuanceId) {
            continue;
        }
        // MPTAmount is omitted from FinalFields when it reaches zero.
        const before = parseRawAmount(previous?.['MPTAmount']);
        const after = parseRawAmount(final['MPTAmount']);
        return before - after;
    }
    throw new VerificationError(`Clawback metadata has no modified MPToken for ${holder}`);
}
function serializable(holder) {
    return { ...holder, rawBalance: holder.rawBalance.toString() };
}
//# sourceMappingURL=issuer.js.map