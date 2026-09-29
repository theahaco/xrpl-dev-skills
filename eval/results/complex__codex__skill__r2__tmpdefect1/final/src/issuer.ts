import { Client, isValidClassicAddress, MPTokenIssuanceCreateFlags as F, type SubmittableTransaction as Transaction, type Wallet, type TxResponse } from 'xrpl';

export const TESTNET = 'wss://s.altnet.rippletest.net:51233';
export const MAX_AMOUNT = '9223372036854775807';
export const CONTROL_FLAGS = F.tfMPTCanLock | F.tfMPTRequireAuth | F.tfMPTCanTransfer | F.tfMPTCanClawback;
export const AUTHORIZED = 2;
export const LOCKED = 1;
export function amount(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(MAX_AMOUNT)) throw new Error('Amount must be a positive integer string within the MPT range');
  return value;
}
export function address(value: string): string {
  if (!isValidClassicAddress(value)) throw new Error('Invalid classic address');
  return value;
}
export interface Signer {
  readonly classicAddress: string;
  sign(transaction: Transaction): ReturnType<Wallet['sign']> | Promise<ReturnType<Wallet['sign']>>;
}
export interface PreparedRecord { hash: string; blob: string; lastLedgerSequence: number; transaction: Transaction }
export interface Receipt { hash: string; ledgerIndex: number; code: string }
/** Writes must commit durably before resolving. Use a database outbox in a backend. */
export interface Journal {
  assertReady(account: string): Promise<void>;
  prepared(record: PreparedRecord): Promise<void>;
  settled(receipt: Receipt): Promise<void>;
}
export class LedgerFailure extends Error {
  constructor(readonly receipt: Receipt) { super(`Validated transaction failed: ${receipt.code} (${receipt.hash})`); }
}
export class UncertainSubmission extends Error {
  constructor(readonly hash: string, readonly lastLedgerSequence: number, options: ErrorOptions) {
    super(`Outcome unknown for ${hash}; reconcile this hash before retrying`, options);
  }
}
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
/** Share per signing account; backend workers also need a distributed account lock. */
export class Executor {
  private readonly queue = new SerialQueue();
  private uncertain = false;
  constructor(readonly client: Client, readonly signer: Signer, private readonly journal: Journal) { address(signer.classicAddress); }
  send(tx: Transaction): Promise<TxResponse["result"]> {
    return this.queue.run(async () => {
      if (this.uncertain) throw new Error('Executor halted; reconcile journal before replacing it');
      if (tx.Account !== this.signer.classicAddress) throw new Error('Signer/account mismatch');
      await this.journal.assertReady(tx.Account);
      const info = await this.client.request({ command: 'server_info' });
      if (info.result.info.network_id !== 1) throw new Error('Restricted to XRPL testnet (network ID 1)');
      const prepared = await this.client.autofill(tx);
      if (!prepared.LastLedgerSequence || !prepared.Fee || BigInt(prepared.Fee) > 10000n) throw new Error('Missing expiry or fee exceeds 0.01 XRP');
      const signed = await this.signer.sign(prepared);
      await this.journal.prepared({ hash: signed.hash, blob: signed.tx_blob, lastLedgerSequence: prepared.LastLedgerSequence, transaction: prepared });
      let response: TxResponse["result"]; 
      try {
        response = (await this.client.submitAndWait(signed.tx_blob)).result;
        if (!response.validated || typeof response.meta !== 'object' || !response.ledger_index) throw new Error('Missing validated metadata');
      } catch (cause) {
        this.uncertain = true;
        throw new UncertainSubmission(signed.hash, prepared.LastLedgerSequence, { cause });
      }
      const receipt = { hash: signed.hash, ledgerIndex: response.ledger_index!, code: typeof response.meta === "object" ? response.meta.TransactionResult : "unknown" };
      try { await this.journal.settled(receipt); } catch (cause) {
        this.uncertain = true;
        throw new UncertainSubmission(signed.hash, prepared.LastLedgerSequence, { cause });
      }
      if (receipt.code !== 'tesSUCCESS') throw new LedgerFailure(receipt);
      return response;
    });
  }
}
export interface BanStore {
  isBanned(issuanceId: string, holder: string): Promise<boolean>;
  /** Persist intent BEFORE ledger transactions. No unban operation is exposed. */
  ban(issuanceId: string, holder: string): Promise<void>;
}
export interface HolderState { balance: string; authorized: boolean; frozen: boolean; exists: boolean }
export class MptIssuer {
  private readonly queue = new SerialQueue();
  private constructor(readonly executor: Executor, readonly issuanceId: string, private readonly bans: BanStore) {}
  static async create(executor: Executor, bans: BanStore): Promise<MptIssuer> {
    const result = await executor.send({ TransactionType: 'MPTokenIssuanceCreate', Account: executor.signer.classicAddress, Flags: CONTROL_FLAGS, AssetScale: 0, MaximumAmount: MAX_AMOUNT });
    const meta = result.meta;
    if (typeof meta !== 'object' || !('mpt_issuance_id' in meta) || typeof meta.mpt_issuance_id !== 'string') throw new Error('Missing issuance ID; recover from creation metadata');
    return MptIssuer.open(executor, meta.mpt_issuance_id, bans);
  }
  static async open(executor: Executor, id: string, bans: BanStore): Promise<MptIssuer> {
    if (!/^[A-Fa-f0-9]{48}$/.test(id)) throw new Error('Invalid MPT issuance ID');
    const issuer = new MptIssuer(executor, id.toUpperCase(), bans);
    const state = await issuer.issuance();
    if (state.Issuer !== executor.signer.classicAddress || (state.Flags & ~LOCKED) !== CONTROL_FLAGS || (state.AssetScale ?? 0) !== 0) throw new Error('Issuance does not match issuer/control profile');
    return issuer;
  }
  async issuance(ledgerHash?: string) {
    const r = await this.executor.client.request({ command: 'ledger_entry', mpt_issuance: this.issuanceId, ...(ledgerHash ? { ledger_hash: ledgerHash } : { ledger_index: 'validated' as const }) });
    if (!r.result.validated || r.result.node?.LedgerEntryType !== 'MPTokenIssuance') throw new Error('Expected validated issuance');
    return r.result.node;
  }
  private holderAddress(holder: string): string {
    address(holder);
    if (holder === this.executor.signer.classicAddress) throw new Error('Issuer cannot be a holder');
    return holder;
  }
  async holder(holder: string, ledgerHash?: string): Promise<HolderState> {
    this.holderAddress(holder);
    try {
      const r = await this.executor.client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: this.issuanceId, account: holder }, ...(ledgerHash ? { ledger_hash: ledgerHash } : { ledger_index: 'validated' as const }) });
      const node: unknown = r.result.node;
      if (!r.result.validated || typeof node !== 'object' || node === null || !('LedgerEntryType' in node) || node.LedgerEntryType !== 'MPToken' || !('Flags' in node) || typeof node.Flags !== 'number') throw new Error('Expected validated holder');
      // rippled omits default-valued fields, including a zero MPTAmount.
      const balance = 'MPTAmount' in node ? node.MPTAmount : '0';
      if (typeof balance !== 'string' || !/^[0-9]+$/.test(balance)) throw new Error('Invalid ledger balance');
      return { exists: true, balance, authorized: !!(node.Flags & AUTHORIZED), frozen: !!(node.Flags & LOCKED) };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'data' in error && typeof error.data === 'object' && error.data !== null && 'error' in error.data && error.data.error === 'entryNotFound') return { exists: false, balance: '0', authorized: false, frozen: false };
      throw error;
    }
  }
  private async allowed(holder: string) {
    this.holderAddress(holder);
    if (await this.bans.isBanned(this.issuanceId, holder)) throw new Error('Holder is permanently banned by issuer policy');
  }
  private authorize(holder: string, revoke: boolean) {
    return this.executor.send({ TransactionType: 'MPTokenAuthorize', Account: this.executor.signer.classicAddress, MPTokenIssuanceID: this.issuanceId, Holder: holder, Flags: revoke ? 1 : 0 });
  }
  approve(holder: string) { return this.queue.run(async () => { await this.allowed(holder); await this.authorize(holder, false); }); }
  mint(holder: string, value: string) {
    amount(value);
    return this.queue.run(async () => {
      await this.allowed(holder);
      const state = await this.holder(holder);
      if (!state.authorized || state.frozen || ((await this.issuance()).Flags & LOCKED)) throw new Error('Holder not authorized or token is frozen');
      await this.executor.send({ TransactionType: 'Payment', Account: this.executor.signer.classicAddress, Destination: holder, Amount: { mpt_issuance_id: this.issuanceId, value } });
    });
  }
  private lock(frozen: boolean, holder?: string) {
    return this.executor.send({ TransactionType: 'MPTokenIssuanceSet', Account: this.executor.signer.classicAddress, MPTokenIssuanceID: this.issuanceId, Flags: frozen ? 1 : 2, ...(holder ? { Holder: holder } : {}) });
  }
  freeze(holder: string) { this.holderAddress(holder); return this.queue.run(async () => { await this.lock(true, holder); }); }
  unfreeze(holder: string) { return this.queue.run(async () => { await this.allowed(holder); await this.lock(false, holder); }); }
  setGlobalFreeze(frozen: boolean) { return this.queue.run(async () => { await this.lock(frozen); }); }
  private claw(holder: string, value: string) {
    return this.executor.send({ TransactionType: 'Clawback', Account: this.executor.signer.classicAddress, Holder: holder, Amount: { mpt_issuance_id: this.issuanceId, value } });
  }
  /** Ledger caps clawback at current balance; zero balance is an error. */
  clawback(holder: string, value: string) {
    this.holderAddress(holder); amount(value);
    return this.queue.run(async () => { await this.claw(holder, value); });
  }
  /** Resumable saga: intent, revoke, drain, verify. */
  ban(holder: string) {
    this.holderAddress(holder);
    return this.queue.run(async () => {
      await this.bans.ban(this.issuanceId, holder);
      let state = await this.holder(holder);
      if (state.exists) {
        if (state.authorized) await this.authorize(holder, true);
        state = await this.holder(holder);
        if (BigInt(state.balance) > 0n) await this.claw(holder, MAX_AMOUNT);
      }
      state = await this.holder(holder);
      if (state.authorized || state.balance !== '0') throw new Error('Ban incomplete; retry after reconciling transactions');
    });
  }
}
