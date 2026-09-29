import { MPTokenIssuanceCreateFlags, type MPTokenIssuanceCreate, type MPTokenAuthorize, type Payment } from 'xrpl';

export function createIssuance(account: string): MPTokenIssuanceCreate {
  return {
    TransactionType: 'MPTokenIssuanceCreate', Account: account,
    AssetScale: 0,
    Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
  };
}

export function authorize(account: string, issuanceId: string, holder?: string): MPTokenAuthorize {
  return {
    TransactionType: 'MPTokenAuthorize', Account: account,
    MPTokenIssuanceID: issuanceId,
    ...(holder ? { Holder: holder } : {}),
  };
}

export function tokenPayment(issuer: string, holder: string, issuanceId: string): Payment {
  return {
    TransactionType: 'Payment', Account: issuer, Destination: holder,
    Amount: { mpt_issuance_id: issuanceId, value: '1000' },
  };
}
