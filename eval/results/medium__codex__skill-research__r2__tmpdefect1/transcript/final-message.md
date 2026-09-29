Completed on testnet. All five transactions validated successfully.

[result.json](/private/tmp/ws/37dffdac14bb/project/result.json) contains:
```json
{
  "issuanceId": "01427CA67BA46E3B9C5D30DF02A7A2A8BE20CD1B5FFC4BF9",
  "holder": "rK2zGXmeWLDqdZCPX6fJvpqYftJRhEKb8n",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

Issuer approval is required and the holder is approved. Both balances were read from the same validated ledger.

Strict compilation, serialization test, and independent ledger verification passed. Run `npm run verify` to check again without sending transactions.

[README](/private/tmp/ws/37dffdac14bb/project/README.md) includes usage; [research notes](/private/tmp/ws/37dffdac14bb/project/research/README.md) document versions, changelog, documentation, and live amendment checks.