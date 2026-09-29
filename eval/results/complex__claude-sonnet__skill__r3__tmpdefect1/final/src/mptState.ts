import type { Client } from "xrpl";

/**
 * Bit flags on the MPTokenIssuance ledger object.
 * https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance
 */
const lsfMPTLocked = 0x00000001; // global freeze
const lsfMPTCanLock = 0x00000002;
const lsfMPTRequireAuth = 0x00000004;
const lsfMPTCanClawback = 0x00000040;

/**
 * Bit flags on the MPToken (holder-side) ledger object.
 * https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken
 */
const lsfMPTHolderLocked = 0x00000001; // per-holder freeze
const lsfMPTHolderAuthorized = 0x00000002; // allowlist approval

export interface IssuanceState {
  issuanceId: string;
  issuer: string;
  outstandingAmount: string;
  maximumAmount?: string;
  assetScale?: number;
  globallyLocked: boolean;
  canLock: boolean;
  requireAuth: boolean;
  canClawback: boolean;
}

export interface HolderState {
  /** false if the holder has never opted in (no MPToken object exists). */
  exists: boolean;
  balance: string;
  authorized: boolean;
  locked: boolean;
}

interface RippledErrorLike {
  data?: { error?: string };
}

function isEntryNotFound(err: unknown): boolean {
  const data = (err as RippledErrorLike)?.data;
  return data?.error === "entryNotFound";
}

export async function getIssuanceState(client: Client, issuanceId: string): Promise<IssuanceState> {
  const response = await client.request({
    command: "ledger_entry",
    mpt_issuance: issuanceId,
  });

  const node = response.result.node as {
    Issuer: string;
    OutstandingAmount: string;
    MaximumAmount?: string;
    AssetScale?: number;
    Flags: number;
  };

  return {
    issuanceId,
    issuer: node.Issuer,
    outstandingAmount: node.OutstandingAmount,
    maximumAmount: node.MaximumAmount,
    assetScale: node.AssetScale,
    globallyLocked: (node.Flags & lsfMPTLocked) !== 0,
    canLock: (node.Flags & lsfMPTCanLock) !== 0,
    requireAuth: (node.Flags & lsfMPTRequireAuth) !== 0,
    canClawback: (node.Flags & lsfMPTCanClawback) !== 0,
  };
}

export async function getHolderState(
  client: Client,
  issuanceId: string,
  holderAddress: string,
): Promise<HolderState> {
  try {
    const response = await client.request({
      command: "ledger_entry",
      mptoken: {
        mpt_issuance_id: issuanceId,
        account: holderAddress,
      },
    });

    const node = response.result.node as { MPTAmount?: string; Flags: number };

    return {
      exists: true,
      balance: node.MPTAmount ?? "0",
      authorized: (node.Flags & lsfMPTHolderAuthorized) !== 0,
      locked: (node.Flags & lsfMPTHolderLocked) !== 0,
    };
  } catch (err) {
    if (isEntryNotFound(err)) {
      return { exists: false, balance: "0", authorized: false, locked: false };
    }
    throw err;
  }
}
