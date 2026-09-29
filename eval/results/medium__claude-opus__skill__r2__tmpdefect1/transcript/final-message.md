Everything is now on the XRPL testnet. After the run, I queried the ledger again separately and it matches `result.json`:

```json
{
  "issuanceId": "01427F5C657F648BBD28A7DBF6C1B12B8A82DB38E704D770",
  "holder": "rpMipewbRrmeRYc92VTgBWxXdBUvgiC6Fo",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

That check also confirmed that the token's "require approval" flag is set and that the holder is marked as approved.

**What the script does** (`src/index.ts`, TypeScript strict mode, `xrpl` 5.3.0):
1. **Issues the token** from your account with the "require approval" flag set, so only holders you approve can hold it. The token uses whole units, so the 1,000 sent is exactly 1,000 tokens.
2. **Creates the holder account** with a new keypair and sends it 5 XRP from your account to cover its reserves and fees. The holder then asks to hold the token and your account approves it.
3. **Sends 1,000 tokens** from your account to the holder.
4. **Reads the balances back** from the latest confirmed ledger: the holder's balance and the total in circulation. It then writes `result.json`.

It stops with an error if any transaction isn't confirmed as successful.

**To run it again:** `XRPL_ISSUER_SEED=<seed> npm start`

**Things to know:**
- **Your seed isn't in any file.** The script reads it from the `XRPL_ISSUER_SEED` environment variable. `.gitignore` excludes `.env`, `node_modules/` and `dist/`. I haven't committed anything.
- **Each run starts over.** It creates a new token and a new holder account, and uses about 5 XRP of your test XRP.
- **The holder's seed was only printed in the run output:** `<TESTNET_SEED_REDACTED>`. Keep it if you want to use that account later. It's testnet only.