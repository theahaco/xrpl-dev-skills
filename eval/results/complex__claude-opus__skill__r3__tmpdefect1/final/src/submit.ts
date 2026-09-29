import type { Client, SubmittableTransaction, TransactionMetadata, Wallet } from 'xrpl';
import { TransactionFailedError, TransactionOutcomeUnknownError } from './errors.js';
import type { AuditLogger } from './logger.js';

export interface SubmittedTransaction {
  hash: string;
  ledgerIndex: number;
  meta: TransactionMetadata;
}

export interface SubmitOptions {
  /** Ledgers the transaction stays valid for after submission. Default 20 (~60-80s). */
  ledgerWindow?: number;
  /** How often to poll for the validated result. Default 1000ms. */
  pollIntervalMs?: number;
  /** Retries when our Sequence was consumed concurrently (tefPAST_SEQ). Default 2. */
  maxSequenceRetries?: number;
}

const DEFAULTS: Required<SubmitOptions> = {
  ledgerWindow: 20,
  pollIntervalMs: 1000,
  maxSequenceRetries: 2,
};

/**
 * Preliminary results that mean this signed transaction was not applied and
 * never can be. Everything else (tes, tec, ter, tefMAX_LEDGER from a stale
 * view) is inconclusive, so we wait for the validated outcome instead.
 */
function isDefinitivePreliminaryFailure(result: string): boolean {
  return result.startsWith('tem') || result.startsWith('tel') || (result.startsWith('tef') && result !== 'tefMAX_LEDGER');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Signs `tx` locally with `wallet`, submits it, and waits until it is in a
 * validated ledger or has provably expired (LastLedgerSequence passed and the
 * server holds full history for the validity window).
 *
 * Resolves only when the transaction validated with tesSUCCESS. Throws
 * {@link TransactionFailedError} for any definitive failure (including
 * validated tec* results, which burn the fee but change nothing else), and
 * {@link TransactionOutcomeUnknownError} if the outcome can't be established.
 */
export async function submitAndConfirm(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  logger: AuditLogger,
  options: SubmitOptions = {},
): Promise<SubmittedTransaction> {
  const opts = { ...DEFAULTS, ...options };
  if (tx.Account !== wallet.classicAddress) {
    throw new TransactionFailedError(
      `Transaction Account ${tx.Account} does not match signing wallet ${wallet.classicAddress}`,
      'localMISMATCHED_SIGNER',
      undefined,
      false,
    );
  }

  for (let attempt = 0; ; attempt++) {
    const unfilled: SubmittableTransaction = { ...tx };
    delete unfilled.Sequence;
    delete unfilled.LastLedgerSequence;
    const prepared = await client.autofill(unfilled);
    const firstLedger = await client.getLedgerIndex();
    const lastLedgerSequence = firstLedger + opts.ledgerWindow;
    prepared.LastLedgerSequence = lastLedgerSequence;
    const { tx_blob, hash } = wallet.sign(prepared);

    logger.debug('tx.submit', { type: tx.TransactionType, hash, sequence: prepared.Sequence, lastLedgerSequence });
    const submitResponse = await client.request({ command: 'submit', tx_blob });
    const preliminary = submitResponse.result.engine_result;

    if (preliminary === 'tefPAST_SEQ' && attempt < opts.maxSequenceRetries) {
      // Another transaction consumed our Sequence, so this signed blob can
      // never apply; it is safe to re-autofill and try again.
      logger.warn('tx.retry_sequence', { type: tx.TransactionType, hash, attempt });
      continue;
    }
    if (isDefinitivePreliminaryFailure(preliminary)) {
      throw new TransactionFailedError(
        `${tx.TransactionType} rejected: ${preliminary} (${submitResponse.result.engine_result_message})`,
        preliminary,
        hash,
        false,
      );
    }

    return await waitForValidation(client, tx.TransactionType, hash, firstLedger, lastLedgerSequence, preliminary, opts);
  }
}

type TxLookup =
  | { status: 'validated'; meta: TransactionMetadata; ledgerIndex: number }
  | { status: 'pending' }
  | { status: 'not_found'; searchedAll: boolean };

async function waitForValidation(
  client: Client,
  type: string,
  hash: string,
  firstLedger: number,
  lastLedgerSequence: number,
  preliminary: string,
  opts: Required<SubmitOptions>,
): Promise<SubmittedTransaction> {
  for (;;) {
    await sleep(opts.pollIntervalMs);
    let validatedLedger: number;
    let found: TxLookup;
    try {
      // Read the ledger index before the lookup: if the tx is absent from a
      // fully-searched range and validation had already passed
      // LastLedgerSequence, it can never be included.
      validatedLedger = await client.getLedgerIndex();
      found = await lookupTx(client, hash, firstLedger, lastLedgerSequence);
    } catch (error) {
      throw new TransactionOutcomeUnknownError(
        `Lost track of ${type} ${hash} (preliminary ${preliminary}); look it up before retrying`,
        hash,
        lastLedgerSequence,
        { cause: error },
      );
    }

    if (found.status === 'validated') {
      const result = found.meta.TransactionResult;
      if (result !== 'tesSUCCESS') {
        throw new TransactionFailedError(`${type} ${hash} failed in validated ledger: ${result}`, result, hash, true);
      }
      return { hash, ledgerIndex: found.ledgerIndex, meta: found.meta };
    }

    if (validatedLedger > lastLedgerSequence && found.status === 'not_found') {
      if (found.searchedAll) {
        throw new TransactionFailedError(
          `${type} ${hash} expired without validating (preliminary ${preliminary}, LastLedgerSequence ${lastLedgerSequence})`,
          preliminary,
          hash,
          false,
        );
      }
      // The server is missing ledgers in the window, so absence proves nothing.
      throw new TransactionOutcomeUnknownError(
        `${type} ${hash} not found, but server history is incomplete for ledgers ${firstLedger}-${lastLedgerSequence}`,
        hash,
        lastLedgerSequence,
      );
    }
  }
}

async function lookupTx(client: Client, hash: string, minLedger: number, maxLedger: number): Promise<TxLookup> {
  try {
    const response = await client.request({
      command: 'tx',
      transaction: hash,
      min_ledger: minLedger,
      max_ledger: maxLedger,
    });
    const { validated, meta, ledger_index } = response.result;
    if (validated === true && typeof meta === 'object' && ledger_index !== undefined) {
      return { status: 'validated', meta, ledgerIndex: ledger_index };
    }
    return { status: 'pending' };
  } catch (error) {
    const data = (error as { data?: { error?: string; searched_all?: boolean } } | null)?.data;
    if (data?.error === 'txnNotFound') {
      return { status: 'not_found', searchedAll: data.searched_all === true };
    }
    throw error;
  }
}
