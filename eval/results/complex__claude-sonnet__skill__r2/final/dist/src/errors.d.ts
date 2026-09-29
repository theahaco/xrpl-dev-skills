/**
 * Thrown whenever a transaction submitted by the issuer module does not
 * validate with `tesSUCCESS`. Carries enough detail (engine result, tx hash,
 * transaction type) for compliance logging and incident response.
 */
export declare class IssuerTransactionError extends Error {
    readonly transactionType: string;
    readonly engineResult?: string;
    readonly txHash?: string;
    constructor(message: string, transactionType: string, engineResult?: string, txHash?: string);
}
/** Thrown for invalid arguments (bad address, non-positive amount, etc.). */
export declare class IssuerInputError extends Error {
    constructor(message: string);
}
