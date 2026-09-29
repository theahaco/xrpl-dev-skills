/** Thrown when a transaction submitted by the issuer module does not succeed on-ledger. */
export class MptTransactionError extends Error {
  readonly transactionType: string;
  readonly resultCode: string;
  readonly txHash?: string;

  constructor(message: string, transactionType: string, resultCode: string, txHash?: string) {
    super(message);
    this.name = 'MptTransactionError';
    this.transactionType = transactionType;
    this.resultCode = resultCode;
    this.txHash = txHash;
    Object.setPrototypeOf(this, MptTransactionError.prototype);
  }
}
