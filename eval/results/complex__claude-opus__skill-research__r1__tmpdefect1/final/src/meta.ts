import type { TransactionMetadata } from 'xrpl';

import { parseLedgerAmount } from './amounts.js';

interface AffectedNodeBody {
  LedgerEntryType: string;
  FinalFields?: Record<string, unknown>;
  PreviousFields?: Record<string, unknown>;
  NewFields?: Record<string, unknown>;
}

/**
 * Returns how much `account`'s balance of the MPT issuance changed in a
 * validated transaction, in base units (negative for a decrease), using the
 * `MPToken` entry diff in the metadata. A zero `MPTAmount` is omitted from
 * ledger entries, so missing values count as zero.
 */
export function mptBalanceChange(meta: TransactionMetadata, issuanceId: string, account: string): bigint {
  for (const affected of meta.AffectedNodes) {
    const node = Object.values(affected)[0] as AffectedNodeBody | undefined;
    if (node?.LedgerEntryType !== 'MPToken') continue;
    const fields = node.FinalFields ?? node.NewFields ?? {};
    if (fields['Account'] !== account || fields['MPTokenIssuanceID'] !== issuanceId) continue;

    const finalAmount = asAmount(fields['MPTAmount']);
    if ('DeletedNode' in affected) return -finalAmount;
    if ('CreatedNode' in affected) return finalAmount;
    // PreviousFields only lists fields that changed. A change *from* zero
    // (an omitted default) may not be listed, so callers must only rely on
    // this for balances that were non-zero beforehand, e.g. clawbacks.
    if (!node.PreviousFields || !('MPTAmount' in node.PreviousFields)) {
      return 0n;
    }
    return finalAmount - asAmount(node.PreviousFields['MPTAmount']);
  }
  return 0n;
}

function asAmount(value: unknown): bigint {
  if (value !== undefined && typeof value !== 'string') throw new Error(`Unexpected MPTAmount ${String(value)}`);
  return parseLedgerAmount(value);
}
