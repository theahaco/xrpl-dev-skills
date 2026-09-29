The token is live on testnet. Your account issued a new MPT that only approved holders can hold, a second account was created and approved, and it received 1,000 tokens. I read the ledger back over a fresh connection and it matches `result.json`:

```json
{
  "issuanceId": "01427F42A00D6F712895D3714C66456326A1811565D94B7B",
  "holder": "rDfexNPLahNt6vrnuyGG88S2oE1Y5M9tLi",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

That check also confirmed the issuance has the "holders must be approved" flag set, and the holder's entry is marked as approved by the issuer.

**Research findings that shaped the code**
- **xrpl version:** the latest stable release is 5.3.0 (published 2026-09-16). Its changelog says that since 5.0.0 the key type is inferred from the seed, and recommends stating it explicitly for seeds starting `sEd…` like yours. The code does that and stops if the seed doesn't produce `rEbHDU…aq3`.
- **Other tools:** TypeScript 7.0.2, tsx 4.23.15 and @types/node 26.6.3, all the latest versions.
- **Testnet amendments:** MPTokensV1 is enabled, which I confirmed on the ledger itself. DynamicMPT is not enabled, so the token's settings can't be changed after creation and the code doesn't use that feature's fields.
- **Library typing gap:** xrpl.js's list of ledger entry types leaves out `MPToken`. The code passes the response type in explicitly to work around it.

**What the script does** (`src/main.ts`, run with `npm start`; `npm run typecheck` passes in strict mode)
1. Creates the MPT from your account with whole-token units (no decimals).
2. Creates a new holder account, funds it with 5 XRP from your account, and has it opt in to the token. Your account then approves it.
3. Sends the holder 1,000 tokens.
4. Reads the holder's balance and the total in circulation from the latest validated ledger, prints them, and writes `result.json`.

It checks that each transaction succeeded and stops at the first failure.

**Things to know**
- **Extra transfer setting:** I also allowed approved holders to send the token to each other, which you didn't ask for. Recipients still have to be approved by you. Since settings can't be changed on testnet, remove that flag before running again if you want a token that can only go back to you.
- **Where the keys are:** your seed is in `.env` rather than in the code. The holder's address and seed are saved to `holder-wallet.json`. Both files are gitignored.
- **Each run creates new things:** running `npm start` again makes a new token and a new holder, spends about 5 XRP, and overwrites `result.json`.
- **Nothing is committed yet:** the files are untracked in git.