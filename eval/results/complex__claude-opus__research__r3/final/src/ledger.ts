import { decodeAccountID, type Client } from 'xrpl'

import { parseRaw } from './amount.js'
import { InvalidInputError } from './errors.js'

/** MPTokenIssuance ledger-entry flags (https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance). */
export const IssuanceFlag = {
  lsfMPTLocked: 0x01,
  lsfMPTCanLock: 0x02,
  lsfMPTRequireAuth: 0x04,
  lsfMPTCanEscrow: 0x08,
  lsfMPTCanTrade: 0x10,
  lsfMPTCanTransfer: 0x20,
  lsfMPTCanClawback: 0x40,
  lsfMPTCanHoldConfidentialBalance: 0x80,
} as const

/** MPToken ledger-entry flags (https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken). */
export const MPTokenFlag = {
  lsfMPTLocked: 0x01,
  lsfMPTAuthorized: 0x02,
} as const

export interface IssuanceState {
  issuanceId: string
  issuer: string
  sequence: number
  assetScale: number
  outstandingRaw: bigint
  maximumRaw: bigint | undefined
  transferFee: number
  metadataHex: string | undefined
  /** Permissioned domain whose credential holders are implicitly authorized. */
  domainId: string | undefined
  flags: number
  globallyFrozen: boolean
  canLock: boolean
  requireAuth: boolean
  canEscrow: boolean
  canTrade: boolean
  canTransfer: boolean
  canClawback: boolean
  canHoldConfidentialBalance: boolean
}

export interface HolderLedgerState {
  /** Whether the holder has an MPToken entry for this issuance (i.e. has opted in). */
  exists: boolean
  /** Issuer approval (lsfMPTAuthorized). */
  authorized: boolean
  /** Individually locked (lsfMPTLocked on the MPToken). Does not reflect a global freeze. */
  frozen: boolean
  balanceRaw: bigint
  /** Amount held in escrow (TokenEscrow). */
  lockedRaw: bigint
  /** Confidential balance fields present (ConfidentialTransfer). */
  hasConfidentialBalance: boolean
}

const ISSUANCE_ID = /^[0-9A-F]{48}$/

export function normalizeIssuanceId(id: string): string {
  const upper = id.toUpperCase()
  if (!ISSUANCE_ID.test(upper)) {
    throw new InvalidInputError(`Invalid MPTokenIssuanceID "${id}"`)
  }
  return upper
}

/** MPTokenIssuanceID = 32-bit big-endian creating Sequence || 160-bit issuer AccountID. */
export function computeIssuanceId(sequence: number, issuer: string): string {
  const seq = sequence.toString(16).padStart(8, '0')
  const account = Buffer.from(decodeAccountID(issuer)).toString('hex')
  return (seq + account).toUpperCase()
}

function isEntryNotFound(err: unknown): boolean {
  const data = (err as { data?: { error?: unknown } } | undefined)?.data
  return data?.error === 'entryNotFound'
}

export async function readIssuance(client: Client, issuanceId: string): Promise<IssuanceState | undefined> {
  const id = normalizeIssuanceId(issuanceId)
  let node: Record<string, unknown>
  try {
    const res = await client.request({ command: 'ledger_entry', mpt_issuance: id, ledger_index: 'validated' })
    node = res.result.node as unknown as Record<string, unknown>
  } catch (err) {
    if (isEntryNotFound(err)) return undefined
    throw err
  }
  const flags = Number(node.Flags ?? 0)
  const has = (flag: number): boolean => (flags & flag) !== 0
  return {
    issuanceId: id,
    issuer: String(node.Issuer),
    sequence: Number(node.Sequence),
    assetScale: Number(node.AssetScale ?? 0),
    outstandingRaw: parseRaw(String(node.OutstandingAmount ?? '0')),
    maximumRaw: node.MaximumAmount === undefined ? undefined : parseRaw(String(node.MaximumAmount)),
    transferFee: Number(node.TransferFee ?? 0),
    metadataHex: typeof node.MPTokenMetadata === 'string' ? node.MPTokenMetadata : undefined,
    domainId: typeof node.DomainID === 'string' ? node.DomainID : undefined,
    flags,
    globallyFrozen: has(IssuanceFlag.lsfMPTLocked),
    canLock: has(IssuanceFlag.lsfMPTCanLock),
    requireAuth: has(IssuanceFlag.lsfMPTRequireAuth),
    canEscrow: has(IssuanceFlag.lsfMPTCanEscrow),
    canTrade: has(IssuanceFlag.lsfMPTCanTrade),
    canTransfer: has(IssuanceFlag.lsfMPTCanTransfer),
    canClawback: has(IssuanceFlag.lsfMPTCanClawback),
    canHoldConfidentialBalance: has(IssuanceFlag.lsfMPTCanHoldConfidentialBalance),
  }
}

export async function readHolder(client: Client, issuanceId: string, holder: string): Promise<HolderLedgerState> {
  const id = normalizeIssuanceId(issuanceId)
  let node: Record<string, unknown>
  try {
    const res = await client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: id, account: holder },
      ledger_index: 'validated',
    })
    node = res.result.node as unknown as Record<string, unknown>
  } catch (err) {
    if (isEntryNotFound(err)) {
      return {
        exists: false,
        authorized: false,
        frozen: false,
        balanceRaw: 0n,
        lockedRaw: 0n,
        hasConfidentialBalance: false,
      }
    }
    throw err
  }
  const flags = Number(node.Flags ?? 0)
  return {
    exists: true,
    authorized: (flags & MPTokenFlag.lsfMPTAuthorized) !== 0,
    frozen: (flags & MPTokenFlag.lsfMPTLocked) !== 0,
    // Zero-valued amounts are omitted from ledger entries.
    balanceRaw: parseRaw(String(node.MPTAmount ?? '0')),
    lockedRaw: parseRaw(String(node.LockedAmount ?? '0')),
    hasConfidentialBalance:
      node.ConfidentialBalanceInbox !== undefined || node.ConfidentialBalanceSpending !== undefined,
  }
}
