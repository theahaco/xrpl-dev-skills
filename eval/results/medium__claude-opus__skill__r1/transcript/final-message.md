The token now exists on testnet: the holder has 1,000 of it and 1,000 is in circulation. I checked this with a separate query after the script finished, and `result.json` is written:

```json
{
  "issuanceId": "01427F3A82E8ECBB42888857707757A85C1DE43E9FE82A44",
  "holder": "rpfNU6cQ4WqSj98sXoogtPLSEUkZZs8Bsv",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

**What the script (`src/index.ts`) does:**
1. **Issues the token** from your account with the "require approval" setting on, so only holders you approve can hold it. It has no decimal places, so "1000" means 1,000 whole tokens.
2. **Sets up the holder.** It creates a new account and funds it with 2.2 XRP from your account, which is the minimum the account needs plus some room for fees. The holder then opts in to the token and your account approves it.
3. **Sends 1,000 tokens** to the holder.
4. **Reads the balances** from the ledger and prints them.

The script only counts a transaction as done once it is final on the ledger and succeeded; any failure stops the run. The follow-up check also confirmed the token requires approval and the holder is approved.

**To run it again:** `ISSUER_SEED=<your seed> npm start`. The seed comes from that environment variable, not from the code, and `.env` is in `.gitignore`. `npm run typecheck` checks the types in strict mode. Each run creates a new token and a new holder and overwrites `result.json`.

**Things to know:**
- **The holder's seed wasn't saved.** The script only printed its address, so nobody can sign for that account now. The tokens and the 2.2 XRP there are stuck, which is harmless on testnet. If you want to use the holder later, I can have the script save its seed to a gitignored file.
- **Holders can only send the token back to you.** I didn't turn on the setting that lets holders transfer it to each other, because you didn't ask for it. It can only be set when the token is issued.
- **Your seed is now in this conversation and my shell history.** That's fine for a testnet-only account, but don't reuse it anywhere.

I haven't committed anything.