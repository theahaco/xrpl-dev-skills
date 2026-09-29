import type { Client, SubmittableTransaction, TxResponse, Wallet } from "xrpl";
import { xrpToDrops } from "xrpl";
import { MAX_FEE_XRP } from "./network";

/**
 * Result of submitting a transaction and waiting for it to be validated.
 */
export interface SubmitOutcome {
  engineResult: string;
  engineResultMessage: string;
  hash: string;
  response: TxResponse;
}

function extractEngineResult(response: TxResponse): { code: string; message: string } {
  const meta = response.result.meta;
  if (meta == null || typeof meta === "string") {
    throw new Error(
      `Transaction ${response.result.hash} did not return parsed metadata (got binary/string meta). ` +
        `Submit with binary: false.`,
    );
  }
  const code = "TransactionResult" in meta ? meta.TransactionResult : undefined;
  if (typeof code !== "string") {
    throw new Error(`Transaction ${response.result.hash} metadata is missing TransactionResult.`);
  }
  const message = "TransactionResultMessage" in meta && typeof meta.TransactionResultMessage === "string"
    ? meta.TransactionResultMessage
    : code;
  return { code, message };
}

/**
 * Signs, submits, and waits for validation of a transaction. Throws if the
 * transaction is not validated on-ledger, but does NOT throw on tec/tem/tef
 * failure codes -- callers decide whether a given engine result is expected
 * (compliance-control callers should call `requireSuccess`, demo negative
 * tests may want to inspect the failure code instead).
 */
export async function submit(client: Client, wallet: Wallet, tx: SubmittableTransaction): Promise<SubmitOutcome> {
  const prepared = await client.autofill(tx);

  const feeDrops = BigInt(prepared.Fee ?? "0");
  const maxFeeDrops = BigInt(xrpToDrops(MAX_FEE_XRP));
  if (feeDrops > maxFeeDrops) {
    throw new Error(
      `Refusing to sign ${tx.TransactionType}: autofilled Fee ${prepared.Fee} drops exceeds the ` +
        `configured maximum of ${maxFeeDrops} drops. This usually indicates fee escalation on the network.`,
    );
  }

  const signed = wallet.sign(prepared);
  const response = await client.submitAndWait(signed.tx_blob);

  if (response.result.validated !== true) {
    throw new Error(
      `${tx.TransactionType} (hash ${response.result.hash}) was not validated on-ledger: ` +
        JSON.stringify(response.result, null, 2),
    );
  }

  const { code, message } = extractEngineResult(response);
  return {
    engineResult: code,
    engineResultMessage: message,
    hash: response.result.hash ?? signed.hash,
    response,
  };
}

/**
 * Same as `submit`, but throws unless the transaction's engine result is
 * exactly `tesSUCCESS`. Use this for every compliance-control transaction --
 * a partial/failed clawback, freeze, or ban must never be silently ignored.
 */
export async function submitAndRequireSuccess(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<SubmitOutcome> {
  const outcome = await submit(client, wallet, tx);
  if (outcome.engineResult !== "tesSUCCESS") {
    throw new Error(
      `${tx.TransactionType} failed with ${outcome.engineResult} (${outcome.engineResultMessage}), ` +
        `hash ${outcome.hash}`,
    );
  }
  return outcome;
}

export { MAX_FEE_XRP };
