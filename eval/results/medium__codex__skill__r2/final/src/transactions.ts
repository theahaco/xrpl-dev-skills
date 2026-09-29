import { MPTokenIssuanceCreateFlags, type MPTokenIssuanceCreate, type Payment } from 'xrpl';

export function createIssuance(account: string): MPTokenIssuanceCreate {
  return {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: account,
    AssetScale: 0,
    MaximumAmount: '1000000',
    Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
      MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
  };
}

export function tokenPayment(account: string, holder: string, issuanceId: string): Payment {
  return {
    TransactionType: 'Payment',
    Account: account,
    Destination: holder,
    Amount: { mpt_issuance_id: issuanceId, value: '1000' },
  };
}
