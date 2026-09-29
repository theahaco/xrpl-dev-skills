import type { Client, SubmittableTransaction, TxResponse, Wallet } from 'xrpl'

/** Thrown when a transaction reaches a validated ledger but did not succeed (a tec-, tem-, or similar non-success result). */
export class TransactionFailedError extends Error {
  constructor(
    public readonly transactionType: string,
    public readonly engineResult: string,
    public readonly engineResultMessage: string | undefined,
    public readonly txHash: string,
  ) {
    super(
      `${transactionType} failed with ${engineResult}${
        engineResultMessage ? `: ${engineResultMessage}` : ''
      } (tx ${txHash})`,
    )
    this.name = 'TransactionFailedError'
  }
}

/**
 * Signs, submits, and waits for validation of a transaction, then verifies it
 * actually succeeded. `tesSUCCESS` at submission only means "queued" -- the
 * authoritative result is the validated ledger's `meta.TransactionResult`.
 */
export async function submitAndVerify<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  transaction: T,
): Promise<TxResponse<T>> {
  const response = await client.submitAndWait(transaction, { wallet })
  const meta = response.result.meta

  const transactionResult =
    typeof meta === 'object' && meta !== null ? meta.TransactionResult : undefined

  if (transactionResult !== 'tesSUCCESS') {
    throw new TransactionFailedError(
      transaction.TransactionType,
      transactionResult ?? 'UNKNOWN',
      typeof meta === 'string' ? meta : undefined,
      response.result.hash,
    )
  }

  return response
}
