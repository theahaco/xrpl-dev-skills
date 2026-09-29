import type { Client, SubmittableTransaction, TxResponse, Wallet } from "xrpl";

/**
 * Submits a transaction signed by `wallet`, waits for validation, and throws
 * unless the ledger applied it with `tesSUCCESS`. Centralizing this avoids
 * every call site silently ignoring a `tec*`/`tem*` result.
 */
export async function submitAndAssertSuccess<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
): Promise<TxResponse<T>> {
  const response = await client.submitAndWait(tx, { wallet, autofill: true });

  const meta = response.result.meta;
  const resultCode =
    meta !== undefined && typeof meta === "object" ? meta.TransactionResult : undefined;

  if (resultCode !== "tesSUCCESS") {
    throw new Error(
      `${tx.TransactionType} from ${String(tx.Account)} did not succeed: ` +
        `${resultCode ?? "no result code returned"} (tx hash ${response.result.hash})`,
    );
  }

  return response;
}

/** True if a `client.request()` rejection was rippled's "entryNotFound" error. */
export function isEntryNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("data" in err)) {
    return false;
  }
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || !("error" in data)) {
    return false;
  }
  return (data as { error?: unknown }).error === "entryNotFound";
}
