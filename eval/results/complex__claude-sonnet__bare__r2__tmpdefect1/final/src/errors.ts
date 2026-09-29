/**
 * Thrown when a transaction submitted by the issuer module does not settle
 * with `tesSUCCESS`. Carries the rippled engine result so callers (e.g. an
 * API layer) can distinguish compliance-relevant failures (tecNO_AUTH,
 * tecFROZEN, ...) from infrastructure failures.
 */
export class MptIssuerError extends Error {
  readonly transactionType: string;
  readonly engineResult?: string;

  constructor(transactionType: string, engineResult: string | undefined, message: string) {
    super(message);
    this.name = 'MptIssuerError';
    this.transactionType = transactionType;
    this.engineResult = engineResult;
  }
}
