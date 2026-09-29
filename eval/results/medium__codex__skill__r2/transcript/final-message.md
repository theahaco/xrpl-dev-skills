Completed on XRPL testnet. All five transactions validated successfully, with holder authorization required.

[result.json](/private/tmp/ws/cf30c0567011/project/result.json) contains:

```json
{
  "issuanceId": "01427CA0FC652136B16EA17826BE0D693D3E5E6EEEB8D432",
  "holder": "rnFBmW8dLKfZKzH8U1aSdrKzQ4aWLnBLBb",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

Strict TypeScript build passed. Both balances were read from a validated ledger and independently rechecked using `npm run read`.

Setup instructions are in [README.md](/private/tmp/ws/cf30c0567011/project/README.md). The holder’s seed is saved locally in Git-ignored `.holder.json`.