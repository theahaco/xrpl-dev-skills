# AccountRoot

[[Source]](https://github.com/XRPLF/rippled/blob/a5d238e7d4fa6ef2b539b759d58744d0a1c33c0c/include/xrpl/protocol/detail/ledger_entries.macro#L129-L153)

An `AccountRoot` ledger entry type describes a single [account](/docs/concepts/accounts), its settings, and XRP balance. You can create a new account by sending a [Payment transaction](/docs/references/protocol/transactions/types/payment) with enough XRP to a mathematically-valid address.

## Example  JSON

```json
{
  "Account": "rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn",
  "AccountTxnID": "0D5FB50FA65C9FE1538FD7E398FFFE9D1908DFA4576D8D7A020040686F93C77D",
  "Balance": "148446663",
  "Domain": "6D64756F31332E636F6D",
  "EmailHash": "98B4375E1D753E5B91627516F6D70977",
  "Flags": 8388608,
  "LedgerEntryType": "AccountRoot",
  "MessageKey": "0000000000000000000000070000000300",
  "OwnerCount": 3,
  "PreviousTxnID": "0D5FB50FA65C9FE1538FD7E398FFFE9D1908DFA4576D8D7A020040686F93C77D",
  "PreviousTxnLgrSeq": 14091160,
  "Sequence": 336,
  "TransferRate": 1004999999,
  "index": "13F1A95D7AAB7108D5CE7EEAF504B2894B8C674E6D68499076441C4837282BF8"
}
```

##  Fields

In addition to the [common fields](/docs/references/protocol/ledger-data/common-fields),  entries have the following fields:

| Field | JSON Type | [Internal Type](/docs/references/protocol/binary-format) | Required? | Description |
|  --- | --- | --- | --- | --- |
| `Account` | String | AccountID | Yes | The identifying [address](/docs/concepts/accounts/addresses) of this account. |
| `AccountTxnID` | String | UInt256 | No | The identifying hash of the transaction most recently sent by this account. This field must be enabled to use the [`AccountTxnID` transaction field](/docs/references/protocol/transactions/common-fields#accounttxnid). To enable it, send an [AccountSet transaction with the `asfAccountTxnID` flag enabled](/docs/references/protocol/transactions/types/accountset#accountset-flags). |
| `AMMID` | String | UInt256 | No | If present, indicates that this is a special AMM [pseudo-account](/docs/concepts/accounts/pseudo-accounts) AccountRoot; always omitted on non-AMM accounts. Contains the ledger entry ID of the corresponding AMM ledger entry. Set during account creation; cannot be modified. _Added by the [AMM amendment](/resources/known-amendments#amm). (Enabled: 2024-03-22)_ |
| `Balance` | String | Amount | No | The account's current [XRP balance in drops](/docs/references/protocol/data-types/basic-data-types#specifying-currency-amounts), represented as a string. |
| `BurnedNFTokens` | Number | UInt32 | No | How many total of this account's issued [non-fungible tokens](/docs/concepts/tokens/nfts) have been burned. This number is always equal or less than `MintedNFTokens`. |
| `Domain` | String | Blob | No | A domain associated with this account. In JSON, this is the hexadecimal for the ASCII representation of the domain. [Cannot be more than 256 bytes in length.](https://github.com/XRPLF/rippled/blob/5b6e8b6f93b19c1e3f6a3467a25639031d9d9a53/include/xrpl/protocol/Protocol.h#L215) |
| `EmailHash` | String | UInt128 | No | The md5 hash of an email address. Clients can use this to look up an avatar through services such as [Gravatar](https://en.gravatar.com/). |
| `FirstNFTokenSequence` | Number | UInt32 | No | The account's [Sequence Number](/docs/references/protocol/data-types/basic-data-types#account-sequence) at the time it minted its first [non-fungible-token](/docs/concepts/tokens/nfts). _Added by the [fixNFTokenRemint amendment](/resources/known-amendments#fixnftokenremint). (Enabled: 2023-11-27)_ |
| `MessageKey` | String | Blob | No | A public key that may be used to send encrypted messages to this account. In JSON, uses hexadecimal. Must be exactly 33 bytes, with the first byte indicating the key type: `0x02` or `0x03` for secp256k1 keys, `0xED` for Ed25519 keys. |
| `MintedNFTokens` | Number | UInt32 | No | How many total [non-fungible tokens](/docs/concepts/tokens/nfts) have been minted by and on behalf of this account. _Added by the [NonFungibleTokensV1_1 amendment](/resources/known-amendments#nonfungibletokensv1_1). (Enabled: 2022-10-31)_ |
| `NFTokenMinter` | String | AccountID | No | Another account that can mint [non-fungible tokens](/docs/concepts/tokens/nfts) on behalf of this account. _Added by the [NonFungibleTokensV1_1 amendment](/resources/known-amendments#nonfungibletokensv1_1). (Enabled: 2022-10-31)_ |
| `OwnerCount` | Number | UInt32 | Yes | The number of objects this account owns in the ledger, which contributes to its owner reserve. |
| `PreviousTxnID` | String | UInt256 | Yes | The identifying hash of the transaction that most recently modified this object. |
| `PreviousTxnLgrSeq` | Number | UInt32 | Yes | The [index of the ledger](/docs/references/protocol/data-types/basic-data-types#ledger-index) that contains the transaction that most recently modified this object. |
| `RegularKey` | String | AccountID | No | The address of a [key pair](/docs/concepts/accounts/cryptographic-keys) that can be used to sign transactions for this account instead of the master key. Use a [SetRegularKey transaction](/docs/references/protocol/transactions/types/setregularkey) to change this value. |
| `Sequence` | Number | UInt32 | Yes | The [sequence number](/docs/references/protocol/data-types/basic-data-types#account-sequence) of the next valid transaction for this account. |
| `Sponsor` | String | AccountID | No | The sponsor paying the account reserve for this account. _Requires the [Sponsor amendment](/resources/known-amendments#sponsor). (Open for Voting: 17.14%)_ |
| `SponsoredOwnerCount` | Number | UInt32 | No | The number of objects this account owns that are sponsored by another account. _Requires the [Sponsor amendment](/resources/known-amendments#sponsor). (Open for Voting: 17.14%)_ |
| `SponsoringAccountCount` | Number | UInt32 | No | The number of accounts this account is sponsoring the account reserve for. _Requires the [Sponsor amendment](/resources/known-amendments#sponsor). (Open for Voting: 17.14%)_ |
| `SponsoringOwnerCount` | Number | UInt32 | No | The number of objects this account is sponsoring the reserve for. _Requires the [Sponsor amendment](/resources/known-amendments#sponsor). (Open for Voting: 17.14%)_ |
| `TicketCount` | Number | UInt32 | No | How many [Tickets](/docs/concepts/accounts/tickets) this account owns in the ledger. This is updated automatically to ensure that the account stays within the hard limit of 250 Tickets at a time. This field is omitted if the account has zero Tickets. |
| `TickSize` | Number | UInt8 | No | How many significant digits to use for exchange rates of Offers involving currencies issued by this address. Valid values are `3` to `15`, inclusive. |
| `TransferRate` | Number | UInt32 | No | A [transfer fee](/docs/concepts/tokens/fungible-tokens/transfer-fees) to charge other users for sending currency issued by this account to each other. |
| `VaultID` | String | UInt256 | No | _Requires the [SingleAssetVault amendment](/resources/known-amendments#singleassetvault). (Open for Voting: 45.71%)_ The ID of the `Vault` entry associated with this account. Set during account creation; cannot be modified. If present, indicates that this is a special Vault [pseudo-account](/docs/concepts/accounts/pseudo-accounts) AccountRoot; always omitted on non-Vault accounts. |
| `WalletLocator` | String | UInt256 | No | An arbitrary 256-bit value that users can set. |
| `WalletSize` | Number | UInt32 | No | Unused. (The code supports this field but there is no way to set it.) |


## Special AMM AccountRoot (Pseudo-Account)

_Added by the [AMM amendment](/resources/known-amendments#amm). (Enabled: 2024-03-22)_

Automated Market Makers use an AccountRoot ledger entry (pseudo-account) to issue their LP Tokens and hold the assets in the AMM pool, and an [AMM ledger entry](/docs/references/protocol/ledger-data/ledger-entry-types/amm) for tracking some of the details of the AMM. The address of an AMM's AccountRoot is randomized so that users cannot identify and fund the address in advance of the AMM being created. Unlike normal accounts, AMM AccountRoot objects are created with the following settings:

- `lsfDisableMaster` **enabled** and no means of authorizing transactions. This ensures no one can control the account directly, and it cannot send transactions.
- `lsfDepositAuth` **enabled** and no accounts preauthorized. This ensures that the only way to add money to the AMM Account is using the [AMMDeposit transaction](/docs/references/protocol/transactions/types/ammdeposit).
- `lsfDefaultRipple` **enabled**. This ensures that users can send and trade the AMM's LP Tokens among themselves.


In addition, the following special rules apply to an AMM's AccountRoot entry:

- It is not subject to the [reserve requirement](/docs/concepts/accounts/reserves). It can hold XRP only if XRP is one of the two assets in the AMM's pool.
- It cannot be the destination of Checks, Escrows, or Payment Channels. Any transactions that would create such entries instead fail with the result code `tecNO_PERMISSION`.
- Users cannot create trust lines to it for anything other than the AMM's LP Tokens. Transactions that would create such trust lines instead fail with result code `tecNO_PERMISSION`. (The AMM does have two trust lines to hold the tokens in its pool, or one trust line if the other asset in its pool is XRP.)
- If the [Clawback amendment](/resources/known-amendments#clawback) is also enabled, the issuer cannot clawback funds from an AMM.


Other than those exceptions, these accounts are like ordinary accounts; the LP Tokens they issue behave like other [tokens](/docs/concepts/tokens) except that those tokens can also be used in AMM-related transactions. You can check an AMM's balances and the history of transactions that affected it the same way you would with a regular account.

## Special Vault AccountRoot (Pseudo-Account)

_Requires the [SingleAssetVault amendment](/resources/known-amendments#singleassetvault). (Open for Voting: 45.71%)_

Vaults use an AccountRoot ledger entry (pseudo-account) to issue their shares and hold the assets deposited into the vault, and a [Vault entry](/docs/references/protocol/ledger-data/ledger-entry-types/vault) for tracking the vault's configuration and state. The address of a vault's AccountRoot is randomized so that users cannot identify and fund the address in advance of the vault being created. Unlike normal accounts, vault AccountRoot objects are created with the following settings:

- `lsfDisableMaster` **enabled** and no means of authorizing transactions. This ensures no one can control the account directly, and it cannot send transactions.
- `lsfDepositAuth` **enabled** and no accounts pre-authorized. This ensures that the only way to add money to the vault's AccountRoot is using the [VaultDeposit transaction](/docs/references/protocol/transactions/types/vaultdeposit).
- `lsfDefaultRipple` **enabled**. This enables rippling for the vault's pseudo-account.


In addition, the following special rules apply to a Vault's AccountRoot entry:

- The vault owner account must pay one [incremental owner reserve](/docs/concepts/accounts/reserves#base-reserve-and-owner-reserve) (currently 0.2 XRP) when creating the vault to cover the pseudo-account.
- The `Sequence` number is always `0` and never changes, preventing the pseudo-account from submitting transactions.
- A pseudo-account is automatically deleted when the vault is deleted, and cannot exist independently of a Vault entry.


## AccountRoot Flags

AccountRoot objects can have the following flags combined in the `Flags` field:

| Flag Name | Hex Value | Decimal Value | Description |
|  --- | --- | --- | --- |
| `lsfAllowTrustLineClawback` | `0x80000000` | 2147483648 | This account has [Clawback](/docs/concepts/tokens/fungible-tokens/clawing-back-tokens) enabled. Once enabled, cannot be disabled. _Added by the [Clawback amendment](/resources/known-amendments#clawback). (Enabled: 2024-02-08)_ |
| `lsfAllowTrustLineLocking` | `0x40000000` | 1073741824 | Trust line tokens issued by this account have [Escrow](/docs/concepts/payment-types/escrow) enabled. _Added by the [TokenEscrow amendment](/resources/known-amendments#tokenescrow). (Enabled: 2026-02-12)_ |
| `lsfDefaultRipple` | `0x00800000` | 8388608 | Enable [rippling](/docs/concepts/tokens/fungible-tokens/rippling) on this addresses's trust lines by default. Required for issuers of trust line tokens; discouraged otherwise. |
| `lsfDepositAuth` | `0x01000000` | 16777216 | This account has [DepositAuth](/docs/concepts/accounts/depositauth) enabled, meaning it can only receive funds from transactions it sends, and from [preauthorized](/docs/concepts/accounts/depositauth#preauthorization) accounts. _Added by the [DepositAuth amendment](/resources/known-amendments#depositauth). (Enabled: 2018-04-06)_ |
| `lsfDisableMaster` | `0x00100000` | 1048576 | This account's [master key pair](/docs/concepts/accounts/cryptographic-keys) is disabled and cannot be used to sign transactions from this account. |
| `lsfDisallowIncomingCheck` | `0x08000000` | 134217728 | This account blocks incoming [checks](/docs/concepts/payment-types/checks). _Added by the [DisallowIncoming amendment](/resources/known-amendments#disallowincoming). (Enabled: 2023-08-21)_ |
| `lsfDisallowIncomingNFTokenOffer` | `0x04000000` | 67108864 | This account blocks incoming [NFT offers](/docs/concepts/tokens/nfts/trading). _Added by the [DisallowIncoming amendment](/resources/known-amendments#disallowincoming). (Enabled: 2023-08-21)_ |
| `lsfDisallowIncomingPayChan` | `0x10000000` | 268435456 | This account blocks incoming [payment channels](/docs/concepts/payment-types/payment-channels). _Added by the [DisallowIncoming amendment](/resources/known-amendments#disallowincoming). (Enabled: 2023-08-21)_ |
| `lsfDisallowIncomingTrustline` | `0x20000000` | 536870912 | This account blocks incoming [trust lines](/docs/concepts/tokens/fungible-tokens/trust-line-tokens). _Added by the [DisallowIncoming amendment](/resources/known-amendments#disallowincoming). (Enabled: 2023-08-21)_ |
| `lsfDisallowXRP` | `0x00080000` | 524288 | Client applications should not send XRP to this account. (Advisory; not enforced by the protocol.) |
| `lsfGlobalFreeze` | `0x00400000` | 4194304 | Trust line tokens issued by this account are [frozen](/docs/concepts/tokens/fungible-tokens/freezes). |
| `lsfNoFreeze` | `0x00200000` | 2097152 | This account cannot freeze trust lines connected to it. Once enabled, cannot be disabled. |
| `lsfPasswordSpent` | `0x00010000` | 65536 | This account has used its [free key reset transaction](/docs/concepts/transactions/transaction-cost#key-reset-transaction). |
| `lsfRequireAuth` | `0x00040000` | 262144 | Trust line tokens issued by this account use [authorized trust lines](/docs/concepts/tokens/fungible-tokens/authorized-trust-lines) (allowlisting). |
| `lsfRequireDestTag` | `0x00020000` | 131072 | Payments to this account must specify a Destination Tag. Commonly used on exchanges and other shared accounts to require incoming payments to specify a customer or purpose to credit the payment towards. |


### Correlation with AccountSet Flags

Many AccountRoot flags correspond to options you can change with an [AccountSet transaction](/docs/references/protocol/transactions/types/accountset). However, the bit values used in the ledger entry are different than the values used to enable or disable those flags in a transaction. Ledger flags have names that begin with **`lsf`**.

The following table shows the correlation between AccountRoot flags and the AccountSet flags that control them:

| Flag Name | Corresponding [AccountSet Flag](/docs/references/protocol/transactions/types/accountset#accountset-flags) |
|  --- | --- |
| `lsfAllowTrustLineClawback` | `asfAllowTrustLineClawback` |
| `lsfAllowTrustLineLocking` | `asfAllowTrustLineLocking` |
| `lsfDefaultRipple` | `asfDefaultRipple` |
| `lsfDepositAuth` | `asfDepositAuth` |
| `lsfDisableMaster` | `asfDisableMaster` |
| `lsfDisallowIncomingCheck` | `asfDisallowIncomingCheck` |
| `lsfDisallowIncomingNFTokenOffer` | `asfDisallowIncomingNFTokenOffer` |
| `lsfDisallowIncomingPayChan` | `asfDisallowIncomingPayChan` |
| `lsfDisallowIncomingTrustline` | `asfDisallowIncomingTrustline` |
| `lsfDisallowXRP` | `asfDisallowXRP` |
| `lsfGlobalFreeze` | `asfGlobalFreeze` |
| `lsfNoFreeze` | `asfNoFreeze` |
| `lsfPasswordSpent` | (None) |
| `lsfRequireAuth` | `asfRequireAuth` |
| `lsfRequireDestTag` | `asfRequireDest` |


##  Reserve

The [reserve](/docs/concepts/accounts/reserves) for an AccountRoot entry is the base reserve, currently 1 XRP, except in the case of a special AMM or Vault AccountRoot.

This XRP cannot be sent to others but it can be burned as part of the [transaction cost](/docs/concepts/transactions/transaction-cost).

##  ID Format

The ID of an AccountRoot entry is the [SHA-512Half](/docs/references/protocol/data-types/basic-data-types#hashes) of the following values, concatenated in order:

* The Account space key (`0x0061`)
* The AccountID of the account


## See Also

- **Concepts:**
  - [Pseudo-Accounts](/docs/concepts/accounts/pseudo-accounts)
- **Transactions:**
  - [AccountSet transaction](/docs/references/protocol/transactions/types/accountset)
  - [AccountDelete transaction](/docs/references/protocol/transactions/types/accountdelete)