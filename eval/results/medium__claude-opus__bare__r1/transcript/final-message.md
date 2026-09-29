I built the project and ran it against testnet. All five transactions succeeded, and the token now exists on the ledger.

**`result.json`**
```json
{
  "issuanceId": "01427F14D14B1DB6FB9E50FA0807CF40869B60FE2504294D",
  "holder": "rH51GiWngRJEm61d3NgP8atH7ukM6Gm56y",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

After the run I queried a testnet server separately and got the same state back:
- **The issuance:** it belongs to your account, has `OutstandingAmount` 1000, and has flags = 4, the setting that means only holders you've approved can hold it.
- **The holder's token record:** it shows a balance of 1000 and flags = 2, which means you've approved it.

**What the script does** (`src/index.ts`)
1. Creates the token with the "holders need approval" setting and gets the issuance ID back from the transaction result.
2. Creates a new holder account and sends it 10 test XRP from your account to activate it.
3. The holder opts in to the token, then your account approves the holder.
4. Sends the holder 1,000 of the token.
5. Reads the holder's balance and the total in circulation from the latest confirmed ledger, checks that the approval setting is really on, and writes `result.json`.

Each step stops with an error if its transaction doesn't come back as successful.

**Running it**
- `npm start` runs the script (it uses `tsx` and loads `.env`); `npm run typecheck` runs `tsc` in strict mode.
- Your seed is in `.env`, not in the code. `.env` is git-ignored, and `.env.example` shows the expected format.
- Each run creates a brand-new token and holder account and overwrites `result.json`.

**Transaction amounts:** the ledger stores token amounts as whole numbers. I didn't set decimal places for the token, so "1000" means exactly 1,000 tokens.

**Holder seed:** the script prints it to the console but doesn't save it. For this run it's `<TESTNET_SEED_REDACTED>`, in case you want to use the holder account later.

The files are in the directory but not committed.