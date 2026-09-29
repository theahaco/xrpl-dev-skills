import { type Client, type LedgerEntry, RippledError } from 'xrpl';

import { parseLedgerAmount } from './amounts.js';

/** `MPTokenIssuance` ledger-entry flags (xrpl.org: MPTokenIssuance entry). */
export const IssuanceFlag = {
  lsfMPTLocked: 0x01,
  lsfMPTCanLock: 0x02,
  lsfMPTRequireAuth: 0x04,
  lsfMPTCanEscrow: 0x08,
  lsfMPTCanTrade: 0x10,
  lsfMPTCanTransfer: 0x20,
  lsfMPTCanClawback: 0x40,
} as const;

/** `MPToken` ledger-entry flags (xrpl.org: MPToken entry). Not exported by xrpl.js. */
export const MPTokenFlag = {
  lsfMPTLocked: 0x01,
  lsfMPTAuthorized: 0x02,
} as const;

export interface IssuanceState {
  issuanceId: string;
  issuer: string;
  assetScale: number;
  outstandingBaseUnits: bigint;
  maximumBaseUnits: bigint | undefined;
  globallyFrozen: boolean;
  canLock: boolean;
  requireAuth: boolean;
  canClawback: boolean;
  canTransfer: boolean;
  canEscrow: boolean;
  canTrade: boolean;
  flags: number;
  ledgerIndex: number;
}

export interface HolderTokenState {
  /** Whether the holder has an `MPToken` entry (i.e. has opted in). */
  optedIn: boolean;
  authorized: boolean;
  frozen: boolean;
  balanceBaseUnits: bigint;
  /** Amount held in escrow; cannot be clawed back while escrowed. */
  escrowedBaseUnits: bigint;
  ledgerIndex: number;
}

/** Reads the issuance from the latest validated ledger, or `undefined` if it does not exist. */
export async function readIssuance(client: Client, issuanceId: string): Promise<IssuanceState | undefined> {
  const response = await ledgerEntryOrUndefined(client, { mpt_issuance: issuanceId });
  if (!response) return undefined;
  const node = response.node as LedgerEntry.MPTokenIssuance;
  const has = (flag: number): boolean => (node.Flags & flag) !== 0;
  return {
    issuanceId,
    issuer: node.Issuer,
    assetScale: node.AssetScale ?? 0,
    outstandingBaseUnits: parseLedgerAmount(node.OutstandingAmount),
    maximumBaseUnits: node.MaximumAmount === undefined ? undefined : parseLedgerAmount(node.MaximumAmount),
    globallyFrozen: has(IssuanceFlag.lsfMPTLocked),
    canLock: has(IssuanceFlag.lsfMPTCanLock),
    requireAuth: has(IssuanceFlag.lsfMPTRequireAuth),
    canClawback: has(IssuanceFlag.lsfMPTCanClawback),
    canTransfer: has(IssuanceFlag.lsfMPTCanTransfer),
    canEscrow: has(IssuanceFlag.lsfMPTCanEscrow),
    canTrade: has(IssuanceFlag.lsfMPTCanTrade),
    flags: node.Flags,
    ledgerIndex: response.ledgerIndex,
  };
}

/** Reads a holder's `MPToken` entry for the issuance from the latest validated ledger. */
export async function readHolderToken(client: Client, issuanceId: string, holder: string): Promise<HolderTokenState> {
  const response = await ledgerEntryOrUndefined(client, {
    mptoken: { mpt_issuance_id: issuanceId, account: holder },
  });
  if (!response) {
    const ledgerIndex = await client.getLedgerIndex();
    return {
      optedIn: false,
      authorized: false,
      frozen: false,
      balanceBaseUnits: 0n,
      escrowedBaseUnits: 0n,
      ledgerIndex,
    };
  }
  const node = response.node as LedgerEntry.MPToken;
  return {
    optedIn: true,
    authorized: (node.Flags & MPTokenFlag.lsfMPTAuthorized) !== 0,
    frozen: (node.Flags & MPTokenFlag.lsfMPTLocked) !== 0,
    balanceBaseUnits: parseLedgerAmount(node.MPTAmount),
    escrowedBaseUnits: parseLedgerAmount(node.LockedAmount),
    ledgerIndex: response.ledgerIndex,
  };
}

type EntrySelector =
  | { mpt_issuance: string }
  | { mptoken: { mpt_issuance_id: string; account: string } };

async function ledgerEntryOrUndefined(
  client: Client,
  selector: EntrySelector,
): Promise<{ node: unknown; ledgerIndex: number } | undefined> {
  try {
    const response = await client.request({ command: 'ledger_entry', ledger_index: 'validated', ...selector });
    // rippled returns ledger_index for validated lookups; xrpl.js does not type it.
    const ledgerIndex = (response.result as { ledger_index?: unknown }).ledger_index;
    if (response.result.validated !== true || typeof ledgerIndex !== 'number') {
      throw new Error('ledger_entry did not return a validated result');
    }
    return { node: response.result.node, ledgerIndex };
  } catch (error) {
    if (error instanceof RippledError && (error.data as { error?: string } | undefined)?.error === 'entryNotFound') {
      return undefined;
    }
    throw error;
  }
}
