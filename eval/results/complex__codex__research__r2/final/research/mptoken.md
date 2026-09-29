# MPToken

[[Source]](https://github.com/XRPLF/rippled/blob/release/3.3.x/include/xrpl/protocol/detail/ledger_entries.macro#L414-L431)

An `MPToken` entry tracks [MPTs](/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens) held by an account that is not the token issuer. You can create or delete an empty `MPToken` entry by sending an [MPTokenAuthorize transaction](/docs/references/protocol/transactions/types/mptokenauthorize). You can send and receive MPTs using a [Payment transaction](/docs/references/protocol/transactions/types/payment).

_Added by the [MPTokensV1 amendment](/resources/known-amendments#mptokensv1). (Enabled: 2025-10-01)_

## Example MPToken JSON

```json
{
    "LedgerEntryType": "MPToken",
    "Account": "rajgkBmMxmz161r8bWYH7CQAFZP5bA9oSG",
    "MPTokenIssuanceID": "000004C463C52827307480341125DA0577DEFC38405B0E3E",
    "Flags": 0,
    "MPTAmount": "100000000",
    "OwnerNode": "1"
}
```

## MPToken Fields

In addition to the [common fields](/docs/references/protocol/ledger-data/common-fields),  entries have the following fields:

| Field Name | JSON Type | Internal Type | Required? | Description |
|  --- | --- | --- | --- | --- |
| `Account` | String - [Address](/docs/references/protocol/data-types/basic-data-types#addresses) | AccountID | Yes | The owner (holder) of these MPTs. |
| `AuditorEncryptedBalance` | String | Blob | No | The holder's total confidential balance encrypted under the auditor's key for independent auditing. Only present if an auditor is configured. _Requires the [ConfidentialTransfer amendment](/resources/known-amendments#confidentialtransfer). (Open for Voting: 31.43%)_ |
| `ConfidentialBalanceInbox` | String | Blob | No | Encrypted inbox balance that receives incoming confidential transfers. Before it can be spent, the holder must merge it into their spending balance using the [ConfidentialMPTMergeInbox transaction](/docs/references/protocol/transactions/types/confidentialmptmergeinbox). Present when the holder has a confidential balance. _Requires the [ConfidentialTransfer amendment](/resources/known-amendments#confidentialtransfer). (Open for Voting: 31.43%)_ |
| `ConfidentialBalanceSpending` | String | Blob | No | Encrypted spending balance used to generate proofs for outgoing transactions. Present when the holder has a confidential balance. _Requires the [ConfidentialTransfer amendment](/resources/known-amendments#confidentialtransfer). (Open for Voting: 31.43%)_ |
| `ConfidentialBalanceVersion` | Number | UInt32 | No | Version number that increments each time the spending balance changes. This version is cryptographically bound to ZKPs in outgoing transactions to prevent replay attacks and ensure proof validity. If the version changes between proof generation and submission, the transaction will fail. _Requires the [ConfidentialTransfer amendment](/resources/known-amendments#confidentialtransfer). (Open for Voting: 31.43%)_ |
| `HolderEncryptionKey` | String | Blob | No | The holder's ElGamal public key for confidential balances. Present when the holder has a confidential balance. _Requires the [ConfidentialTransfer amendment](/resources/known-amendments#confidentialtransfer). (Open for Voting: 31.43%)_ |
| `IssuerEncryptedBalance` | String | Blob | No | Copy of the holder's total confidential balance encrypted for the issuer to audit supply. Present when the holder has a confidential balance. _Requires the [ConfidentialTransfer amendment](/resources/known-amendments#confidentialtransfer). (Open for Voting: 31.43%)_ |
| `LockedAmount` | String - Number | UInt64 | No | The amount of tokens currently locked up (for example, in escrow). _Added by the [TokenEscrow amendment](/resources/known-amendments#tokenescrow). (Enabled: 2026-02-12)_ |
| `MPTAmount` | String - Number | UInt64 | Yes | The amount of tokens currently held by the owner. The minimum is 0 and the maximum is 263-1. |
| `MPTokenIssuanceID` | String - Hexadecimal | UInt192 | Yes | The `MPTokenIssuance` identifier. |
| `OwnerNode` | String | UInt64 | Yes | A hint indicating which page of the owner directory links to this entry, in case the directory consists of multiple pages. |
| `PreviousTxnID` | String - [Hash](/docs/references/protocol/data-types/basic-data-types#hashes) | UInt256 | Yes | The identifying hash of the transaction that most recently modified this entry. |
| `PreviousTxnLgrSeq` | Number | UInt32 | Yes | The sequence of the ledger that contains the transaction that most recently modified this object. |


### MPToken Flags

entries can have the following flags combined in the `Flags` field:

| Flag Name | Flag Value | Description |
|  --- | --- | --- |
| `lsfMPTLocked` | `0x00000001` | If enabled, indicates that the MPT owned by this account is currently locked and cannot be used in any XRP transactions other than sending value back to the issuer. |
| `lsfMPTAuthorized` | `0x00000002` | (Only applicable for allow-listing) If set, indicates that the issuer has authorized the holder for the MPT. This flag can be set using a `MPTokenAuthorize` transaction; it can also be "un-set" using a `MPTokenAuthorize` transaction specifying the `tfMPTUnauthorize` flag. |


## MPToken ID Format

The ID of an `MPToken` entry is the [SHA-512Half](/docs/references/protocol/data-types/basic-data-types#hashes) of the following values, concatenated in order:

- The `MPToken` space key (0x0074).
- The `MPTokenIssuanceID` for the issuance being held.
- The `AccountID` of the token holder.


## See Also

- [MPTokenAuthorize transaction](/docs/references/protocol/transactions/types/mptokenauthorize)