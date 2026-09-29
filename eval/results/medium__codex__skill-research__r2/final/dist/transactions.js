import { MPTokenIssuanceCreateFlags } from 'xrpl';
export function createIssuance(account) {
    return { TransactionType: 'MPTokenIssuanceCreate', Account: account,
        AssetScale: 0, MaximumAmount: '1000000',
        Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth };
}
export function tokenPayment(account, holder, issuanceId) {
    return { TransactionType: 'Payment', Account: account, Destination: holder,
        Amount: { mpt_issuance_id: issuanceId, value: '1000' } };
}
