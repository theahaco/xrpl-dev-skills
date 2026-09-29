Your token now exists on the XRPL testnet, the holder has 1,000 of it, and `result.json` has been written:

```json
{
  "issuanceId": "01427F51EB4C2B6E07A37406DB0421E0BEB302EB081123BA",
  "holder": "rat9aZDQew4YbHKqioxE6CTL7U19XkXEPT",
  "holderBalance": "1000",
  "outstandingAmount": "1000"
}
```

Every transaction reached `tesSUCCESS` in a validated ledger. I also re-queried the ledger directly, separately from the script, and it matches:
- **The issuance** has flags `4`, which is the "only approved holders" setting, and 1,000 tokens in circulation.
- **The holder** has flags `2`, meaning you've approved them, and a balance of 1,000.

**What the research turned up:**
- **`xrpl` 5.3.0** (16 Sep 2026) is the latest stable release. One change that affects this project: since 5.0, loading a wallet from a seed picks the key type from the seed's prefix. The script names the type (ed25519) explicitly anyway.
- **Testnet amendments:** `MPTokensV1` is enabled, but `DynamicMPT` and `ConfidentialTransfer` are not, so the script uses none of their features. Testnet reserves are 1 XRP per account plus 0.2 XRP per owned ledger object.
- **Docs:** I read the xrpl.org pages for `MPTokenIssuanceCreate`, `MPTokenAuthorize`, `Payment` (MPT section), the `MPTokenIssuance` and `MPToken` ledger entries, and `ledger_entry`.
- **Other packages:** TypeScript 7.0.2 and @types/node 26.6.3, running on Node 24.

**The project:**
- The code is `src/index.ts`, compiled in strict mode.
- `npm start` builds it and runs it against testnet.
- Your seed is kept in `.env`, which is excluded from git, rather than in the source.

**Decisions worth knowing about:**
- **Decimal places are set to 0**, so an on-ledger amount of `"1000"` means exactly 1,000 tokens.
- **Holders can't pass the token to each other.** You only asked for approved holders, so I didn't turn on transfers. Holders can only send the token back to you. If you want peer-to-peer transfers, it has to be enabled when the token is created.
- **The holder is a new random account** funded with 3 XRP from yours. Its seed is `<TESTNET_SEED_REDACTED>`, which the script also prints, in case you want to use it later.
- **Each run creates a new token and a new holder** and overwrites `result.json`.
- **xrpl 5.3.0 typing gap:** the library's list of ledger object types leaves out `MPToken`. The script works around this with a small typed helper, `getLedgerEntry`.

I haven't tested that an unapproved account is actually refused the token. I also haven't committed anything; the files are untracked in the repo.