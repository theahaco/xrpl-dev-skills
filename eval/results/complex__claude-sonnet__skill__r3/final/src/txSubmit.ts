import type { Client, SubmittableTransaction, TxResponse, Wallet } from "xrpl";

export class TransactionFailedError extends Error {
  constructor(
    public readonly transactionType: string,
    public readonly resultCode: string,
    public readonly hash: string | undefined,
  ) {
    super(`${transactionType} failed with result ${resultCode} (hash: ${hash ?? "unknown"})`);
    this.name = "TransactionFailedError";
  }
}

/**
 * Autofills, signs, submits, and waits for validation of a transaction, then
 * throws unless the validated result is exactly `tesSUCCESS`.
 *
 * Never trusts the initial submission response alone — only a validated
 * ledger result is treated as final, per XRPL reliable-submission guidance.
 */
export async function submitAndVerify<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  transaction: T,
): Promise<TxResponse<T>> {
  const prepared = await client.autofill(transaction);
  const response = await client.submitAndWait(prepared, { wallet, autofill: false });

  const meta = response.result.meta;
  const resultCode =
    typeof meta === "object" && meta !== null && "TransactionResult" in meta
      ? String(meta.TransactionResult)
      : undefined;

  if (resultCode !== "tesSUCCESS") {
    throw new TransactionFailedError(
      transaction.TransactionType,
      resultCode ?? "UNKNOWN",
      response.result.hash,
    );
  }

  return response;
}
