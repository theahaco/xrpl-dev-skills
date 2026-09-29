import type { Client, SubmittableTransaction, TxResponse, Wallet } from 'xrpl'

/**
 * Thrown when a transaction was validated by the network but did not
 * succeed (e.g. a `tec*` result), or when the client gave up waiting for
 * validation. Carries the raw response so callers can inspect it.
 */
export class TransactionFailedError extends Error {
  readonly transactionType: string
  readonly resultCode: string
  readonly response: TxResponse

  constructor(transactionType: string, resultCode: string, response: TxResponse) {
    super(`${transactionType} did not succeed (result: ${resultCode})`)
    this.name = 'TransactionFailedError'
    this.transactionType = transactionType
    this.resultCode = resultCode
    this.response = response
  }
}

function extractResultCode(response: TxResponse): string {
  const meta = response.result.meta
  if (meta == null || typeof meta === 'string') {
    return 'UNKNOWN'
  }
  return meta.TransactionResult
}

/**
 * Autofills, signs, submits, and waits for validation of a transaction.
 * Throws {@link TransactionFailedError} unless the transaction is validated
 * with a `tesSUCCESS` result. Never returns a "maybe it worked" response, so
 * callers do not need to re-check `validated` themselves.
 */
export async function submitAndVerify(
  client: Client,
  wallet: Wallet,
  transaction: SubmittableTransaction,
): Promise<TxResponse> {
  const response = await client.submitAndWait(transaction, { wallet })

  if (response.result.validated !== true) {
    throw new TransactionFailedError(
      transaction.TransactionType,
      extractResultCode(response),
      response,
    )
  }

  const resultCode = extractResultCode(response)
  if (resultCode !== 'tesSUCCESS') {
    throw new TransactionFailedError(transaction.TransactionType, resultCode, response)
  }

  return response
}
