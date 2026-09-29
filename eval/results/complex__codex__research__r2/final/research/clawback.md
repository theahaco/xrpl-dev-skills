# Clawback

[Source](https://github.com/XRPLF/rippled/blob/release/3.4.x/src/libxrpl/tx/transactors/token/Clawback.cpp)

[Claw back tokens](/docs/concepts/tokens/fungible-tokens/clawing-back-tokens) issued by your account. Issuers can only claw back [trust line tokens](/docs/concepts/tokens/fungible-tokens/trust-line-tokens) if they enabled the **Allow Trust Line Clawback** setting before issuing any tokens. Issuers can claw back [MPTs](/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens) if the corresponding MPT Issuance has clawback enabled.

_Added by the [Clawback amendment](/resources/known-amendments#clawback). (Enabled: 2024-02-08)_

## Example  JSON

```json
{
  "TransactionType": "Clawback",
  "Account": "rp6abvbTbjoce8ZDJkT6snvxTZSYMBCC9S",
  "Amount": {
      "currency": "FOO",
      "issuer": "rsA2LpzuawewSBQXkiju3YQTMzW13pAAdW",
      "value": "314.159"
    }
}
```

##  Fields

In addition to the [common fields](/docs/references/protocol/transactions/common-fields),  transactions use the following fields:

| Field | JSON Type | [Internal Type](/docs/references/protocol/binary-format) | Required? | Description |
|  --- | --- | --- | --- | --- |
| `Amount` | [Currency Amount](/docs/references/protocol/data-types/basic-data-types#specifying-currency-amounts) | Amount | Yes | The amount to claw back. The quantity in the `value` sub-field must not be zero. If this is more than the current balance, the transaction claws back the entire balance. When clawing back trust line tokens, the `issuer` sub-field indicates the token holder to claw back tokens from. |
| `Holder` | String | AccountID | No | The holder to claw back tokens from, if clawing back MPTs. The holder must have a non-zero balance of the MPT issuance indicated in the `Amount` field. _Added by the [MPTokensV1 amendment](/resources/known-amendments#mptokensv1). (Enabled: 2025-10-01)_ |


When clawing back trust line tokens, you must omit the `Holder` field. When clawing back MPTs, you must provide the `Holder` field.

## Error Cases

Besides errors that can occur for all transactions,  transactions can result in the following [transaction result codes](/docs/references/protocol/transactions/transaction-results):

| Error Code | Description |
|  --- | --- |
| `temDISABLED` | The [Clawback amendment](/resources/known-amendments#clawback) is not enabled. |
| `temBAD_AMOUNT` | The amount of tokens specified to claw back is invalid or zero, or the specified holder is the issuer. |
| `tecAMM_ACCOUNT` | The specified holder is an Automated Market Maker (AMM). To claw back tokens from an AMM, use [`AMMClawback`](/docs/references/protocol/transactions/types/ammclawback) instead. |
| `tecNO_LINE` | There is no trust line with the counterparty or that trust line's balance is 0. |
| `tecNO_PERMISSION` | The sender of this transaction does not have the ability to claw back the specified tokens. |