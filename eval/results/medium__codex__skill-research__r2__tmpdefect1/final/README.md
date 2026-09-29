# XRPL testnet MPT demo

Small strict TypeScript CLI using xrpl 5.3.0. Creates an MPT requiring issuer authorization, funds a new holder with 5 test XRP, opts the holder in, approves it, and issues exactly 1,000 tokens. AssetScale is zero. Holder-to-holder transfers are disabled; issuer payments are supported.

```sh
npm ci
npm test
ISSUER_SEED='<testnet issuer seed>' npm start
```

The completed run is in `result.json`. Run `npm run verify` without a seed to read and check the existing balances again; this sends no transactions. Both balances are read with `ledger_entry` using the same validated ledger hash. `ledger-evidence.json` records the raw entries and ledger hash, and `transactions.json` records all five transaction hashes and validated ledger indexes.

The script signs locally, bounds fees to 0.01 XRP per transaction, sets expiry through autofill, checks testnet network ID and MPTokensV1, and requires validated `tesSUCCESS` for each transaction. It checks authorization flags as well as balances. The holder seed is saved locally in gitignored `.holder.json` with mode 0600. The issuer seed is supplied through the environment and is not stored.

`run-state.json` prevents accidental duplicate runs. If a run fails, inspect its recorded transaction hashes on testnet before attempting recovery; do not delete the guard and blindly rerun. Transactions that validated before a failure remain on-ledger. Testnet resets can remove these objects.

Reserve/fee impact: the holder receives 5 XRP from the issuer; the issuance and holder token entry each require an owner reserve (currently 0.2 XRP). The holder also needs the 1 XRP account reserve. Transaction fees consume a small amount of test XRP. No real XRP is used.

Research and sources: [research/README.md](research/README.md).
