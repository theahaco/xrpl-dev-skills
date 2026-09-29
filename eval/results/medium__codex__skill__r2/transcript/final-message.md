Completed on testnet. All five transactions validated, and issuer approval is required for holders.

[result.json](/private/tmp/ws/ffe7cce6e96d/project/result.json) contains:

```json
{
  "issuanceId": "0142A4EBEF924BB9A9A8463810CD7FD6A1852A63512AE071",
  "holder": "rn35NgWvwrjBm2qPaUq8GvMcDg3DreKLPT",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

Strict TypeScript build, both tests, and independent ledger verification passed. Run `npm run verify` to check again.

Usage is in [README.md](/private/tmp/ws/ffe7cce6e96d/project/README.md). The holder received 5 test XRP; its seed is saved in Git-ignored `.holder.json`.