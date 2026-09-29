import { MPTokenIssuanceCreateFlags, MPTokenIssuanceCreateImmutableFlags } from 'xrpl'

/** Ledger flags on an MPTokenIssuance object. */
export const IssuanceFlag = {
  Locked: 0x01,
  CanLock: 0x02,
  RequireAuth: 0x04,
  CanEscrow: 0x08,
  CanTrade: 0x10,
  CanTransfer: 0x20,
  CanClawback: 0x40,
  CanHoldConfidentialBalance: 0x80,
} as const

/** Ledger flags on an MPToken (holder) object. */
export const HolderFlag = {
  Locked: 0x01,
  Authorized: 0x02,
} as const

/**
 * Capabilities every compliant issuance must have:
 *  - CanLock:     per-holder and global freeze
 *  - RequireAuth: allowlist; holders need explicit issuer approval
 *  - CanClawback: clawback, and zeroing out banned holders
 */
export const REQUIRED_ISSUANCE_FLAGS = {
  CanLock: IssuanceFlag.CanLock,
  RequireAuth: IssuanceFlag.RequireAuth,
  CanClawback: IssuanceFlag.CanClawback,
} as const

/**
 * Capabilities that would let value leave the reach of the controls above,
 * so a compliant issuance must NOT have them:
 *  - CanEscrow:                  escrowed amounts sit outside the holder's clawable balance
 *  - CanTrade:                   DEX/AMM exposure the controls here don't govern
 *  - CanHoldConfidentialBalance: encrypted balances can't be inspected or clawed back the normal way
 */
export const FORBIDDEN_ISSUANCE_FLAGS = {
  CanEscrow: IssuanceFlag.CanEscrow,
  CanTrade: IssuanceFlag.CanTrade,
  CanHoldConfidentialBalance: IssuanceFlag.CanHoldConfidentialBalance,
} as const

export function creationFlags(allowHolderTransfers: boolean): number {
  let flags =
    MPTokenIssuanceCreateFlags.tfMPTCanLock |
    MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
    MPTokenIssuanceCreateFlags.tfMPTCanClawback
  if (allowHolderTransfers) flags |= MPTokenIssuanceCreateFlags.tfMPTCanTransfer
  return flags
}

/**
 * With the DynamicMPT amendment, issuance flags and the transfer fee are
 * mutable by default. We pin all of them so the compliance posture can't be
 * changed after creation. Metadata stays mutable (e.g. to update a URL).
 */
export const PINNED_IMMUTABLE_FLAGS =
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanLock |
  MPTokenIssuanceCreateImmutableFlags.tifMPTRequireAuth |
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanEscrow |
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanTrade |
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanTransfer |
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanClawback |
  MPTokenIssuanceCreateImmutableFlags.tifMPTCanHoldConfidentialBalance |
  MPTokenIssuanceCreateImmutableFlags.tifMPTTransferFee

export interface IssuanceSnapshot {
  Issuer: string
  Flags: number
  DomainID?: string | undefined
  LockedAmount?: string | undefined
}

/**
 * Returns every reason the issuance can't be operated safely. An empty
 * list means it's compliant.
 */
export function issuanceProblems(issuance: IssuanceSnapshot, expectedIssuer: string): string[] {
  const problems: string[] = []
  if (issuance.Issuer !== expectedIssuer) {
    problems.push(`issuer is ${issuance.Issuer}, expected ${expectedIssuer}`)
  }
  for (const [name, bit] of Object.entries(REQUIRED_ISSUANCE_FLAGS)) {
    if ((issuance.Flags & bit) === 0) problems.push(`missing required capability ${name}`)
  }
  for (const [name, bit] of Object.entries(FORBIDDEN_ISSUANCE_FLAGS)) {
    if ((issuance.Flags & bit) !== 0) problems.push(`forbidden capability ${name} is enabled`)
  }
  // With a DomainID, anyone holding the domain's credentials is treated as
  // authorized. That would bypass both the allowlist and bans.
  if (issuance.DomainID !== undefined) {
    problems.push(`DomainID ${issuance.DomainID} is set; domain credentials would bypass the allowlist`)
  }
  if (issuance.LockedAmount !== undefined && issuance.LockedAmount !== '0') {
    problems.push(`${issuance.LockedAmount} units are held in escrow`)
  }
  return problems
}
