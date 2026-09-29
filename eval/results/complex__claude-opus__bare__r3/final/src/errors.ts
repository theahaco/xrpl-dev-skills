/** Base class for all errors raised by the issuer module. */
export class MptIssuerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A transaction was validated with a result other than tesSUCCESS. */
export class TransactionFailedError extends MptIssuerError {
  constructor(
    readonly transactionType: string,
    readonly resultCode: string,
    readonly hash: string | undefined,
  ) {
    super(`${transactionType} failed with ${resultCode}${hash ? ` (tx ${hash})` : ''}`)
  }
}

/** The operation is not permitted because the address is banned. */
export class HolderBannedError extends MptIssuerError {
  constructor(readonly address: string) {
    super(`${address} is banned from holding this token`)
  }
}

/** The holder is individually frozen. */
export class HolderFrozenError extends MptIssuerError {
  constructor(readonly address: string) {
    super(`${address} is frozen`)
  }
}

/** The token is globally frozen. */
export class TokenFrozenError extends MptIssuerError {
  constructor(readonly issuanceId: string) {
    super(`Token ${issuanceId} is globally frozen`)
  }
}

/** The holder has not created an MPToken (opted in) for this issuance yet. */
export class HolderNotOptedInError extends MptIssuerError {
  constructor(readonly address: string) {
    super(`${address} has not opted in to this token (no MPToken object on ledger)`)
  }
}

/** A clawback request exceeds the holder's balance. */
export class InsufficientBalanceError extends MptIssuerError {
  constructor(
    readonly address: string,
    readonly requested: string,
    readonly available: string,
  ) {
    super(`Cannot claw back ${requested} from ${address}: balance is ${available}`)
  }
}

/** The on-ledger issuance does not match what the module requires. */
export class IssuanceConfigError extends MptIssuerError {}

/** A post-condition check against validated ledger state failed. */
export class StateVerificationError extends MptIssuerError {}
