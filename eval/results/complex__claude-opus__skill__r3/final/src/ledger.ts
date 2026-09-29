import type { Client, LedgerEntry } from 'xrpl';
import { isValidClassicAddress } from 'xrpl';
import { ledgerAmount } from './amounts.js';
import { InvalidInputError, IssuanceConfigurationError } from './errors.js';

/** MPTokenIssuance ledger flags. */
export const IssuanceFlags = {
  lsfMPTLocked: 0x01,
  lsfMPTCanLock: 0x02,
  lsfMPTRequireAuth: 0x04,
  lsfMPTCanEscrow: 0x08,
  lsfMPTCanTrade: 0x10,
  lsfMPTCanTransfer: 0x20,
  lsfMPTCanClawback: 0x40,
  lsfMPTCanHoldConfidentialBalance: 0x80,
} as const;

/** MPToken (holder balance entry) ledger flags. */
export const MPTokenFlags = {
  lsfMPTLocked: 0x01,
  lsfMPTAuthorized: 0x02,
} as const;

export interface IssuanceState {
  issuanceId: string;
  issuer: string;
  assetScale: number;
  maximumAmount: bigint | undefined;
  outstandingAmount: bigint;
  globallyFrozen: boolean;
  flags: number;
}

export interface HolderLedgerState {
  address: string;
  /** Holder has created its MPToken entry (MPTokenAuthorize from the holder). */
  optedIn: boolean;
  /** Issuer has approved the holder (lsfMPTAuthorized). */
  authorized: boolean;
  /** Individually frozen (lsfMPTLocked on the holder's MPToken). */
  frozen: boolean;
  balance: bigint;
}

export function assertClassicAddress(address: string, field = 'address'): void {
  if (typeof address !== 'string' || !isValidClassicAddress(address)) {
    throw new InvalidInputError(`${field} must be a valid classic XRPL address, got ${JSON.stringify(address)}`);
  }
}

export function assertIssuanceId(id: string): void {
  if (typeof id !== 'string' || !/^[0-9A-F]{48}$/.test(id)) {
    throw new InvalidInputError(`issuanceId must be 48 uppercase hex characters, got ${JSON.stringify(id)}`);
  }
}

function isEntryNotFound(error: unknown): boolean {
  return (error as { data?: { error?: string } }).data?.error === 'entryNotFound';
}

/** All reads use the latest validated ledger, never the open or current ledger. */
export async function readIssuance(client: Client, issuanceId: string): Promise<IssuanceState> {
  let node: LedgerEntry.MPTokenIssuance;
  try {
    const response = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated',
    });
    node = response.result.node as LedgerEntry.MPTokenIssuance;
  } catch (error) {
    if (isEntryNotFound(error)) {
      throw new IssuanceConfigurationError(`MPT issuance ${issuanceId} does not exist in the validated ledger`);
    }
    throw error;
  }
  return {
    issuanceId,
    issuer: node.Issuer,
    assetScale: node.AssetScale ?? 0,
    maximumAmount: node.MaximumAmount === undefined ? undefined : BigInt(node.MaximumAmount),
    outstandingAmount: ledgerAmount(node.OutstandingAmount),
    globallyFrozen: (node.Flags & IssuanceFlags.lsfMPTLocked) !== 0,
    flags: node.Flags,
  };
}

export async function readHolder(client: Client, issuanceId: string, address: string): Promise<HolderLedgerState> {
  try {
    const response = await client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account: address },
      ledger_index: 'validated',
    });
    const node = response.result.node as unknown as LedgerEntry.MPToken;
    return {
      address,
      optedIn: true,
      authorized: (node.Flags & MPTokenFlags.lsfMPTAuthorized) !== 0,
      frozen: (node.Flags & MPTokenFlags.lsfMPTLocked) !== 0,
      balance: ledgerAmount(node.MPTAmount),
    };
  } catch (error) {
    if (isEntryNotFound(error)) {
      return { address, optedIn: false, authorized: false, frozen: false, balance: 0n };
    }
    throw error;
  }
}
