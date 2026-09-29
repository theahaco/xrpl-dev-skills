/** Base class for every error raised by this module. */
export class IssuerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** A caller supplied an argument that can never be valid (bad address, bad amount, ...). */
export class InvalidArgumentError extends IssuerError {}

/** The target address is banned for this issuance; the requested operation is refused. */
export class BannedHolderError extends IssuerError {
  constructor(readonly holder: string) {
    super(`Holder ${holder} is banned for this issuance`)
  }
}

/** The holder's on-ledger state does not allow the requested operation. */
export class HolderStateError extends IssuerError {
  constructor(
    readonly holder: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The holder, or the whole token, is frozen. Raised by the module for issuer-originated payments,
 * which the ledger's MPT lock does not block on its own.
 */
export class FrozenError extends IssuerError {
  constructor(
    readonly scope: 'holder' | 'global',
    readonly holder?: string,
  ) {
    super(scope === 'global' ? 'The token is globally frozen' : `Holder ${holder ?? ''} is frozen`)
  }
}

/**
 * The MPT issuance on ledger does not have the configuration this module requires
 * (e.g. clawback not enabled, or a capability that would let holders escape controls).
 */
export class IssuanceConfigError extends IssuerError {}

/**
 * How a transaction ended:
 * - `failed`:   included in a validated ledger with a non-success (tec) result; the fee was charged,
 *               nothing else changed.
 * - `rejected`: refused before inclusion (tem/tef/tel/...); it was never applied.
 * - `expired`:  not included by its LastLedgerSequence; it was never applied and never can be.
 */
export type TransactionFailureKind = 'failed' | 'rejected' | 'expired'

/** A transaction did not succeed. `engineResult` holds the rippled result code, e.g. `tecLOCKED`. */
export class TransactionFailedError extends IssuerError {
  constructor(
    readonly kind: TransactionFailureKind,
    readonly transactionType: string,
    readonly engineResult: string,
    readonly hash: string,
    readonly ledgerIndex?: number,
  ) {
    super(`${transactionType} ${kind}: ${engineResult} (tx ${hash})`)
  }
}

/**
 * A transaction was submitted but its final outcome could not be determined (e.g. the connection
 * to rippled kept failing). It may or may not have been applied: reconcile using `hash` before retrying.
 */
export class TransactionOutcomeUnknownError extends IssuerError {
  constructor(
    readonly transactionType: string,
    readonly hash: string,
    options?: ErrorOptions,
  ) {
    super(`${transactionType} outcome unknown; reconcile tx ${hash} before retrying`, options)
  }
}

/**
 * A ban was recorded but on-ledger enforcement could not be confirmed. The ban record is kept,
 * so the holder remains blocked by this module; retrying `ban()` resumes enforcement.
 */
export class BanEnforcementError extends IssuerError {
  constructor(
    readonly holder: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
