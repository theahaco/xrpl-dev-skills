import type { Client, SubmittableTransaction, TxResponse, Wallet } from 'xrpl'

/**
 * Submits a transaction signed by `wallet`, waits for validation, and throws
 * unless the ledger applied it with tesSUCCESS. Compliance-critical calls
 * (freeze, clawback, ban, ...) must never silently no-op on a tec/tem failure.
 */
export async function submitAndCheck<T extends SubmittableTransaction>(
  client: Client,
  tx: T,
  wallet: Wallet,
): Promise<TxResponse<T>> {
  const response = await client.submitAndWait(tx, { wallet, autofill: true })
  const meta = response.result.meta
  const code = typeof meta === 'string' ? undefined : meta?.TransactionResult
  if (code !== 'tesSUCCESS') {
    throw new Error(
      `${tx.TransactionType} failed with ${code ?? 'no metadata'} (tx hash ${response.result.hash})`,
    )
  }
  return response
}

/** Like {@link submitAndCheck}, but returns the result code instead of throwing. Only for call sites that intentionally exercise an expected-to-fail path (e.g. compliance demos proving a freeze blocks a transfer). */
export async function submitAndReport<T extends SubmittableTransaction>(
  client: Client,
  tx: T,
  wallet: Wallet,
): Promise<{ code: string; response: TxResponse<T> }> {
  const response = await client.submitAndWait(tx, { wallet, autofill: true })
  const meta = response.result.meta
  const code = typeof meta === 'string' ? 'no metadata' : meta?.TransactionResult ?? 'no metadata'
  return { code, response }
}
