import { MPTokenIssuanceCreateFlags } from 'xrpl';
export function createIssuance(account) {
    return {
        TransactionType: 'MPTokenIssuanceCreate', Account: account,
        AssetScale: 0,
        Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    };
}
export function authorize(account, issuanceId, holder) {
    return {
        TransactionType: 'MPTokenAuthorize', Account: account,
        MPTokenIssuanceID: issuanceId,
        ...(holder ? { Holder: holder } : {}),
    };
}
export function tokenPayment(issuer, holder, issuanceId) {
    return {
        TransactionType: 'Payment', Account: issuer, Destination: holder,
        Amount: { mpt_issuance_id: issuanceId, value: '1000' },
    };
}
