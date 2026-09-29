Completed on testnet. All five transactions validated successfully.

[result.json](/private/tmp/ws/08a2d6c55b99/project/result.json) contains:

```json
{
  "issuanceId": "0142A4EC29D9FF1D2E082131CC31786E909A8DD3D860BB5C",
  "holder": "r3modrZSQRCc8ki2Pbb9xYPFGYuH2Ybhpa",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

Issuer approval is required, and the holder is approved. Strict compilation, serialization/signing tests, and separate ledger verification passed.

See [README.md](/private/tmp/ws/08a2d6c55b99/project/README.md) for usage and [RESEARCH.md](/private/tmp/ws/08a2d6c55b99/project/RESEARCH.md) for version, documentation, and amendment checks. Holder credentials are saved locally in Git-ignored `.secrets/holder.json`.