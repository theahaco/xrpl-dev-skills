import { RippledError, type Client, type SubmittableTransaction, type TransactionMetadata, type Wallet } from 'xrpl';

import {
  TransactionExpiredError,
  TransactionFailedError,
  TransactionOutcomeUnknownError,
} from './errors.js';

export interface ValidatedTransaction {
  hash: string;
  resultCode: string;
  ledgerIndex: number;
  meta: TransactionMetadata;
}

export interface SubmitOptions {
  /** How many ledgers the transaction may wait for inclusion (sets LastLedgerSequence). Default 20 (~80s). */
  ledgerWindow?: number;
  /** Poll interval while waiting for validation. Default 1000ms. */
  pollIntervalMs?: number;
  /** Hard ceiling on total wait before giving up with TransactionOutcomeUnknownError. Default 180s. */
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Signs, submits and waits for a transaction to reach a *final* outcome.
 *
 * Unlike `Client.submitAndWait`, this only declares a transaction expired after a
 * ledger lookup covering its whole validity window proves it was never included,
 * so a transaction that validates in its final ledger is never mis-reported as
 * failed. The hash is computed locally before submission so every error carries it
 * for reconciliation.
 *
 * Returns validated transactions regardless of result code; use `requireSuccess`
 * (or `submitOrThrow`) to turn non-`tesSUCCESS` results into errors.
 */
export async function submitAndConfirm(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  options: SubmitOptions = {},
): Promise<ValidatedTransaction> {
  const { ledgerWindow = 20, pollIntervalMs = 1000, timeoutMs = 180_000 } = options;
  const type = tx.TransactionType;

  const firstLedger = await client.getLedgerIndex();
  const prepared = await client.autofill({ ...tx, LastLedgerSequence: firstLedger + ledgerWindow });
  const lastLedger = prepared.LastLedgerSequence as number;
  const { tx_blob: blob, hash } = wallet.sign(prepared);

  let preliminary: string;
  try {
    const res = await client.request({ command: 'submit', tx_blob: blob });
    preliminary = res.result.engine_result;
  } catch (err) {
    throw new TransactionOutcomeUnknownError(type, hash, 'submit request failed', { cause: err });
  }
  // tem = malformed: can never be applied, never relayed.
  if (preliminary.startsWith('tem')) {
    throw new TransactionFailedError(type, preliminary, hash);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    try {
      const res = await client.request({
        command: 'tx',
        transaction: hash,
        min_ledger: firstLedger,
        max_ledger: lastLedger,
      });
      if (res.result.validated) {
        const meta = res.result.meta;
        if (typeof meta !== 'object' || meta === null) {
          throw new TransactionOutcomeUnknownError(type, hash, 'validated transaction returned without metadata');
        }
        return {
          hash,
          resultCode: meta.TransactionResult,
          ledgerIndex: res.result.ledger_index ?? 0,
          meta: meta as TransactionMetadata,
        };
      }
      // Found but not yet validated: keep waiting.
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknownError) throw err;
      if (!(err instanceof RippledError) || (err.data as { error?: string } | undefined)?.error !== 'txnNotFound') {
        // Transient (e.g. reconnect in progress): keep polling until the deadline.
        continue;
      }
      const validatedLedger = await client.getLedgerIndex().catch(() => 0);
      if (validatedLedger > lastLedger) {
        // Past the validity window and not found. Only conclusive if the server has the whole range.
        if ((err.data as { searched_all?: boolean }).searched_all === true) {
          throw new TransactionExpiredError(type, hash, preliminary);
        }
        throw new TransactionOutcomeUnknownError(type, hash, 'server lacks complete history for the validity window');
      }
    }
  }
  throw new TransactionOutcomeUnknownError(type, hash, `no final outcome after ${timeoutMs}ms`);
}

export function requireSuccess(type: string, result: ValidatedTransaction): ValidatedTransaction {
  if (result.resultCode !== 'tesSUCCESS') {
    throw new TransactionFailedError(type, result.resultCode, result.hash, result.ledgerIndex);
  }
  return result;
}

export async function submitOrThrow(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  options?: SubmitOptions,
): Promise<ValidatedTransaction> {
  return requireSuccess(tx.TransactionType, await submitAndConfirm(client, wallet, tx, options));
}
