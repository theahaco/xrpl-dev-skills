# Payment

[Source](https://github.com/XRPLF/rippled/blob/release/3.4.x/src/libxrpl/tx/transactors/payment/Payment.cpp)

Send value to an account. (Depending on the path taken, this can involve exchanges of several types of funds, all of which occur atomically.) This transaction type can be used for several [types of payments](#types-of-payments).

Payments are also the only way to [create accounts](#creating-accounts).

## Example  JSON

```json
{
  "TransactionType" : "Payment",
  "Account" : "rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn",
  "Destination" : "ra5nK24KXen9AHvsdFTKHSANinZseWnPcX",
  "DeliverMax" : {
     "currency" : "USD",
     "value" : "1",
     "issuer" : "rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn"
  },
  "Fee": "12",
  "Flags": 2147483648,
  "Sequence": 2,
}
```

##  Fields

In addition to the [common fields](/docs/references/protocol/transactions/common-fields),  transactions use the following fields:

| Field | JSON Type | [Internal Type](/docs/references/protocol/binary-format) | Required? | Description |
|  --- | --- | --- | --- | --- |
| `Amount` | [Currency Amount](/docs/references/protocol/data-types/basic-data-types#specifying-currency-amounts) | Amount | API v1: Yes | Alias to `DeliverMax`. |
| `CredentialIDs` | Array of Strings | Vector256 | No | Set of Credentials to authorize a deposit made by this transaction. Each member of the array must be the ledger entry ID of a Credential entry in the ledger. _Added by the [Credentials amendment](/resources/known-amendments#credentials). (Enabled: 2025-09-04)_ |
| `DeliverMax` | [Currency Amount](/docs/references/protocol/data-types/basic-data-types#specifying-currency-amounts) | Amount | Yes | [API v2](/docs/references/http-websocket-apis#api-versioning): The maximum amount of currency to deliver. [Partial payments](#partial-payments) can deliver less than this amount and still succeed; other payments fail unless they deliver the exact amount. New in: rippled 2.0.0 |
| `DeliverMin` | [Currency Amount](/docs/references/protocol/data-types/basic-data-types#specifying-currency-amounts) | Amount | No | Minimum amount of destination currency this transaction should deliver. Only valid if this is a [partial payment](#partial-payments). |
| `Destination` | String - [Address](/docs/references/protocol/data-types/basic-data-types#addresses) | AccountID | Yes | The account receiving the payment. |
| `DestinationTag` | Number | UInt32 | No | Arbitrary tag that identifies the reason for the payment to the destination, or a hosted recipient to pay. |
| `DomainID` | String - [Hash](/docs/references/protocol/data-types/basic-data-types#hashes) | UInt256 | No | The ledger entry ID of a permissioned domain. If this is a cross-currency payment, only use the corresponding [permissioned DEX](/docs/concepts/tokens/decentralized-exchange/permissioned-dexes) to convert currency. Both the sender and the recipient must have valid credentials that grant access to the specified domain. This field has no effect if the payment is not cross-currency. _Added by the [PermissionedDEX amendment](/resources/known-amendments#permissioneddex). (Enabled: 2026-02-18)_ If this field is used, the transaction verifies that the domain still exists, failing with `tecNO_PERMISSION` if not. It also deletes expired credentials from the ledger for the sender and destination accounts it checks against the domain. _Requires the [fixCleanup3_4_0 amendment](/resources/known-amendments#fixcleanup3_4_0). (Open for Voting: 0.00%)_ |
| `InvoiceID` | String - Hexadecimal | UInt256 | No | Arbitrary 256-bit value representing a specific reason or identifier for this payment. |
| `Paths` | Array of path arrays | PathSet | No | *(Auto-fillable)* Array of [payment paths](/docs/concepts/tokens/fungible-tokens/paths) to be used for this transaction. Must be omitted for XRP-to-XRP transactions. |
| `SendMax` | [Currency Amount](/docs/references/protocol/data-types/basic-data-types#specifying-currency-amounts) | Amount | No | Highest amount of source currency this transaction is allowed to cost, including [transfer fees](/docs/concepts/tokens/fungible-tokens/transfer-fees), exchange rates, and [slippage](http://en.wikipedia.org/wiki/Slippage_%28finance%29). Does not include the [XRP destroyed as a cost for submitting the transaction](/docs/concepts/transactions/transaction-cost). Must be supplied for cross-currency/cross-issue payments. Must be omitted for XRP-to-XRP payments. |


When specifying a transaction, you must specify either `Amount` or `DeliverMax`, but not both. When displaying transactions in JSON, API v1 always uses `Amount` and API v2 (or later) always uses `DeliverMax`.

## Types of Payments

The `Payment` transaction type functions differently depending on how you fill in the `Payment` fields:

| Payment type | `Amount` | `SendMax` | `Paths` | `Account` = `Destination`? | Description |
|  --- | --- | --- | --- | --- | --- |
| [Direct XRP Payment](/docs/concepts/payment-types/direct-xrp-payments) | String (XRP) | Omitted | Omitted | No | Transfers XRP directly from one account to another, using one transaction. Always delivers the exact amount. No fee applies other than the basic [transaction cost](/docs/concepts/transactions/transaction-cost). |
| [Creating or redeeming tokens](/docs/concepts/tokens) | Object | Object (optional) | Optional | No | Increases or decreases the amount of a non-XRP currency or asset tracked in the XRP Ledger. [Transfer fees](/docs/concepts/tokens/fungible-tokens/transfer-fees) and [freezes](/docs/concepts/tokens/fungible-tokens/freezes) do not apply when sending and redeeming directly. |
| [Cross-currency Payment](/docs/concepts/payment-types/cross-currency-payments) | Object (non-XRP) / String (XRP) | Object (non-XRP) / String (XRP) | Usually required | No | Send tokens from one holder to another. The `Amount` or `SendMax` can be XRP or tokens, but can't both be XRP. These payments [ripple through](/docs/concepts/tokens/fungible-tokens/rippling) the issuer and can take longer [paths](/docs/concepts/tokens/fungible-tokens/paths) through several intermediaries if the transaction specifies a path set. [Transfer fees](/docs/concepts/tokens/fungible-tokens/transfer-fees) set by the issuer(s) apply to this type of transaction. These transactions consume offers in the [decentralized exchange](/docs/concepts/tokens/decentralized-exchange) to connect different currencies, or currencies with the same currency code and different issuers. |
| [Partial payment](/docs/concepts/payment-types/partial-payments) | Object (non-XRP) / String (XRP) | Object (non-XRP) / String (XRP) | Usually required | No | Sends *up to* a specific amount of any currency. Uses the [`tfPartialPayment` flag](#payment-flags). May include a `DeliverMin` amount specifying the minimum that the transaction must deliver to be successful; if the transaction does not specify `DeliverMin`, it can succeed by delivering *any positive amount*. |
| Currency conversion | Object (non-XRP) / String (XRP) | Object (non-XRP) / String (XRP) | Required | Yes | Consumes offers in the [decentralized exchange](/docs/concepts/tokens/decentralized-exchange) to convert one currency to another, possibly taking [arbitrage](https://en.wikipedia.org/wiki/Arbitrage) opportunities. The `Amount` and `SendMax` cannot both be XRP. Also called a *circular payment* because it delivers money to the sender. This type of transaction may be classified as an "exchange" and not a "payment". |
| MPT Payment | Object | Omitted | Omitted | No | Send MPTs to a holder. See [MPT Payments](#mpt-payments). |


## Special issuer Values for SendMax and Amount

Most of the time, the `issuer` field of a non-XRP [Currency Amount](/docs/references/protocol/data-types/basic-data-types#specifying-currency-amounts) indicates the issuer of a token. However, when describing payments, there are special rules for the `issuer` field in the `DeliverMax` (or `Amount`) and `SendMax` fields of a payment.

* There is only ever one balance between two addresses for the same currency code. This means that, sometimes, the `issuer` field of an amount actually refers to a counterparty, instead of the address that issued the token.
* When the `issuer` field of the destination `DeliverMax` field matches the `Destination` address, it is treated as a special case meaning "any issuer that the destination accepts." This includes all addresses to which the destination has trust lines with a positive limit, as well as tokens issued by the destination itself.
* When the `issuer` field of the `SendMax` field matches the source account's address, it is treated as a special case meaning "any issuer that the source can use." The payment can send tokens the source account already holds, or issue new tokens to others who have trust lines with the source account.


In all of these cases, the currency code must still match exactly.

## Creating Accounts

The Payment transaction type can create new accounts in the XRP Ledger by sending enough XRP to an unfunded address. Other transactions to unfunded addresses always fail.

For more information, see [Creating Accounts](/docs/concepts/accounts#creating-accounts).

## Paths

If present, the `Paths` field must contain a *path set* - an array of path arrays. Each individual path represents one way value can flow from the sender to receiver through various intermediary accounts, order books, and automated market makers. A single transaction can potentially use multiple paths, for example if the transaction exchanges currency using several different order books to achieve the best rate.

You must omit the `Paths` field for direct payments, including:

* An XRP-to-XRP transfer.
* A direct transfer on a trust line that connects the sender and receiver.


If the `Paths` field is provided, the server decides at transaction processing time which paths to use, from the provided set plus a *default path* (the most direct way possible to connect the specified accounts). This decision is deterministic and attempts to minimize costs, but it is not guaranteed to be perfect.

The `Paths` field must not be an empty array, nor an array whose members are all empty arrays.

For more information, see [Paths](/docs/concepts/tokens/fungible-tokens/paths).

## Payment Flags

Transactions of the Payment type support additional values in the [`Flags` field](/docs/references/protocol/transactions/common-fields#flags-field), as follows:

| Flag Name | Hex Value | Decimal Value | Description |
|  --- | --- | --- | --- |
| `tfNoRippleDirect` | `0x00010000` | 65536 | Do not use the default path; only use paths included in the `Paths` field. This is intended to force the transaction to take arbitrage opportunities. Most clients do not need this. |
| `tfPartialPayment` | `0x00020000` | 131072 | If the specified `Amount` cannot be sent without spending more than `SendMax`, reduce the received amount instead of failing outright. See [Partial Payments](#partial-payments) for more details. |
| `tfLimitQuality` | `0x00040000` | 262144 | Only take paths where all the conversions have an input:output ratio that is equal or better than the ratio of `Amount`:`SendMax`. See [Limit Quality](#limit-quality) for details. |
| `tfSponsorCreatedAccount` | `0x00080000` | 524288 | Only valid when this Payment [creates a new account](#creating-accounts). If enabled, the `Account` sending the transaction sponsors the reserve of the newly created account. Cannot be combined with `tfNoRippleDirect`, `tfPartialPayment`, or `tfLimitQuality`, and the `Amount` must be XRP. _Requires the [Sponsor amendment](/resources/known-amendments#sponsor). (Open for Voting: 17.14%)_ |


## Partial Payments

A partial payment allows a payment to succeed by reducing the amount received. Partial payments are useful for [returning payments](/docs/concepts/payment-types/bouncing-payments) without incurring additional costs to oneself. However, partial payments can also be used to exploit integrations that naively assume the `Amount` field of a successful transaction always describes the exact amount delivered. To reduce confusion, `Amount` has been renamed to `DeliverMax` in API v2 and later.

A partial payment is any [Payment transaction](/docs/references/protocol/transactions/types/payment) with the `tfPartialPayment` flag enabled. A partial payment can be successful if it delivers any positive amount greater than or equal to its `DeliverMin` field (or any positive amount at all if `DeliverMin` is not specified) without sending more than the `SendMax` value.

The [`delivered_amount`](/docs/references/protocol/transactions/metadata#delivered_amount) field of a payment's metadata indicates the amount of currency actually received by the destination account.

For more information, see the full article on [Partial Payments](/docs/concepts/payment-types/partial-payments).

## Limit Quality

The XRP Ledger defines the "quality" of a currency exchange as the ratio of the numeric amount in to the numeric amount out. For example, if you spend $2 USD to receive £1 GBP, then the "quality" of that exchange is `0.5`. 

The [`tfLimitQuality` flag](#payment-flags) allows you to set a minimum quality of conversions that you are willing to take. This limit quality is defined as the destination `Amount` divided by the `SendMax` amount (the numeric amounts only, regardless of currency). When set, the payment processing engine avoids using any paths whose quality (conversion rate) is worse (numerically lower) than the limit quality.

By itself, the `tfLimitQuality` flag reduces the number of situations in which a transaction can succeed. Specifically, it rejects payments where some part of the payment uses an unfavorable conversion, even if the overall *average* quality of conversions in the payment is equal or better than the limit quality. If a payment is rejected in this way, the [transaction result](/docs/references/protocol/transactions/transaction-results) is `tecPATH_DRY`.

Consider the following example. If I am trying to send you 100 Chinese Yuan (`Amount` = 100 CNY) for 20 United States dollars (`SendMax` = 20 USD) or less, then the limit quality is `5`. Imagine one trader is offering ¥95 for $15 (a ratio of about `6.3` CNY per USD), but the next best offer in the market is ¥5 for $2 (a ratio of `2.5` CNY per USD). If I were to take both offers to send you 100 CNY, then it would cost me 17 USD, for an average quality of about `5.9`.

Without the `tfLimitQuality` flag set, this transaction would succeed, because the $17 it costs me is within my specified `SendMax`. However, with the `tfLimitQuality` flag enabled, the transaction would fail instead, because the path to take the second offer has a quality of `2.5`, which is worse than the limit quality of `5`.

The `tfLimitQuality` flag is most useful when combined with [partial payments](/docs/concepts/payment-types/partial-payments). When both `tfPartialPayment` and `tfLimitQuality` are set on a transaction, then the transaction delivers as much of the destination `Amount` as it can, without using any conversions that are worse than the limit quality.

In the above example with a ¥95/$15 offer and a ¥5/$2 offer, the situation is different if my transaction has both `tfPartialPayment` and `tfLimitQuality` enabled. If we keep my `SendMax` of 20 USD and a destination `Amount` of 100 CNY, then the limit quality is still `5`. However, because I am doing a partial payment, the transaction sends as much as it can instead of failing if the full destination amount cannot be sent. This means that my transaction consumes the ¥95/$15 offer, whose quality is about `6.3`, but it rejects the ¥5/$2 offer because that offer's quality of `2.5` is worse than the quality limit of `5`. In the end, my transaction only delivers ¥95 instead of the full ¥100, but it avoids wasting money on poor exchange rates.

## MPT Payments

When you send a payment using [MPTs](/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens), the *Amount* field requires only the `mpt_issuance_id` and the `value`. The `MPTokenIssuanceID` is used to uniquely identify the MPT for the transaction.

Version 1 MPTokens only support direct MPT payment between accounts. They cannot be traded in the decentralized exchange.

_Added by the [MPTokensV1 amendment](/resources/known-amendments#mptokensv1). (Enabled: 2025-10-01)_

### Sample MPT Payment transaction

```json
{
   "Account": "rLWSJKbwYSzG32JuGissYd66MFTvfMk4Bt",
   "Amount": {
      "mpt_issuance_id": "006419063CEBEB49FC20032206CE0F203138BFC59F1AC578",
      "value": "100"
   },
   "DeliverMax": {
      "mpt_issuance_id": "006419063CEBEB49FC20032206CE0F203138BFC59F1AC578",
      "value": "100"
   },
   "SendMax": {
      "mpt_issuance_id": "006419063CEBEB49FC20032206CE0F203138BFC59F1AC578",
      "value": "100"
   },
   "Destination": "raZ3wTTKiMHn3BiStvz4ET9rbCHfU1DMak",
   "Fee": "120",
   "Flags": 0,
}
```

## Credential IDs

You can send money to an account that uses [Deposit Authorization](/docs/concepts/accounts/depositauth) by providing the `CredentialIDs` field with an exact set of credentials that are preauthorized by the recipient. The set of credentials must match a [DepositPreauth entry](/docs/references/protocol/ledger-data/ledger-entry-types/depositpreauth) in the ledger.

The credentials provided in the `CredentialIDs` field must all be valid, meaning:

- The provided credentials must exist.
- The provided credentials must have been accepted by the subject.
- None of the provided credentials may be expired.
- The sender of this transaction must be the subject of each of the credentials.
- None of the provided credentials may be zero. _Requires the [fixCleanup3_4_0 amendment](/resources/known-amendments#fixcleanup3_4_0). (Open for Voting: 0.00%)_


If you provide credentials even though the destination account does not use Deposit Authorization, the credentials are not needed but they are still checked for validity.

Note
The `CredentialIDs` field is only used for deposit authorization, not for trading in a [permissioned DEX](/docs/concepts/tokens/decentralized-exchange/permissioned-dexes), even though Permissioned DEXes also use credentials to grant access. To trade in a permissioned DEX, you use the `DomainID` field to specify a domain for which you hold valid credentials.

_Added by the [Credentials amendment](/resources/known-amendments#credentials). (Enabled: 2025-09-04)_

## Special Case for Destination Accounts Below the Reserve

If an account has Deposit Authorization enabled, but its current XRP balance is less than the [reserve requirement](/docs/concepts/accounts/reserves), there is a special exception to Deposit Authorization where anyone can send a Payment transaction, without preauthorization, for up to the base account reserve; this exists as an emergency measure to prevent an account from getting "stuck" without enough XRP to transact. To qualify for this special case, the payment MUST NOT use the `CredentialIDs` field.