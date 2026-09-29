export type AuditAction =
  | 'createIssuance'
  | 'approveHolder'
  | 'revokeApproval'
  | 'issue'
  | 'clawback'
  | 'freezeHolder'
  | 'unfreezeHolder'
  | 'freezeAll'
  | 'unfreezeAll'
  | 'ban'

/** One record per compliance action attempted, successful or not. */
export interface AuditEvent {
  timestamp: string
  action: AuditAction
  issuanceId: string
  holder?: string
  /** Amount in base units, as a base-10 string. */
  amount?: string
  outcome: 'success' | 'noop' | 'error'
  /** Hashes of every transaction the action submitted, in order. */
  txHashes: string[]
  detail?: string
}

/**
 * Receives audit events. It is awaited, so an implementation that writes to durable storage
 * delays the call's return until the record is stored. If it throws, the error is reported to
 * the caller, but ledger changes already made are not rolled back.
 */
export type AuditSink = (event: AuditEvent) => void | Promise<void>
