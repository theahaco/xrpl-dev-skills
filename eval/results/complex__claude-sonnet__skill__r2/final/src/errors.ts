/**
 * Thrown whenever a transaction submitted by the issuer module does not
 * validate with `tesSUCCESS`. Carries enough detail (engine result, tx hash,
 * transaction type) for compliance logging and incident response.
 */
export class IssuerTransactionError extends Error {
  public readonly transactionType: string;
  public readonly engineResult?: string;
  public readonly txHash?: string;

  constructor(
    message: string,
    transactionType: string,
    engineResult?: string,
    txHash?: string,
  ) {
    super(message);
    this.name = "IssuerTransactionError";
    this.transactionType = transactionType;
    this.engineResult = engineResult;
    this.txHash = txHash;
  }
}

/** Thrown for invalid arguments (bad address, non-positive amount, etc.). */
export class IssuerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssuerInputError";
  }
}
