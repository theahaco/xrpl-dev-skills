I wrote the project and ran it against testnet. Everything now exists on the ledger. I checked the result from a fresh connection: the holder has 1,000, the total in circulation is 1,000, the issuance requires approval, and the holder is marked as approved.

**`result.json`**
```json
{
  "issuanceId": "0142A205B7C4D51563D98509A7BCD59475618F2DF0F82141",
  "holder": "rXakofve3pbda9dftxKiLATsDjHPzc8TD",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

**What the script does** (`src/index.ts`, strict TypeScript, `xrpl` 5.3.0):
1. **Issues the token** from your account with the "require auth" flag on, so only holders you approve can hold it.
2. **Sets up the holder:** it creates a new account and funds it from yours with 2.2 XRP (the account reserve, one token holding, and 1 XRP for fees). The holder then opts in to the token, and your account approves it.
3. **Sends** the holder 1,000 of the token.
4. **Reads both balances back** from the latest confirmed ledger, prints them, and writes `result.json`.

Each step checks that its transaction was confirmed and succeeded, and the script stops on the first failure. Your account went from 100 to about 97.8 XRP: 2.2 went to the holder, and the rest was fees.

**To run it:**
```sh
npm install
XRPL_ISSUER_SEED=<your seed> npm start
npm run typecheck
```

**Things to know:**
- **Your seed isn't in the code.** The script reads it from the `XRPL_ISSUER_SEED` environment variable.
- **The holder's seed is saved** in `holder-wallet.json` so you can keep using that account. The file is readable only by you and is excluded from git.
- **Each run starts fresh.** It creates a new token and a new holder rather than reusing the ones above.
- **Holders can't send the token to each other.** I didn't turn on the "can transfer" option because you didn't ask for it, so the holder can only send the token back to you. It's one flag (`tfMPTCanTransfer`) if you want it.
- **Amounts are whole units** (no decimal places), so "1000" means exactly 1,000 tokens.
- **Nothing is committed to git yet.** The new files are sitting uncommitted in the repo.