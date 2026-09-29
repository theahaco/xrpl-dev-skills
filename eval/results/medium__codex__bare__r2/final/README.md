# XRPL testnet MPT demo

Strict TypeScript using the npm `xrpl` package. The endpoint is fixed to XRP Ledger **testnet**.

```sh
npm ci
npm run check
npm start
```

The completed project's `npm start` reads the existing issuance and holder from
`result.json`, verifies their validated ledger entries, and refreshes the balances.
It does not issue or send more tokens on subsequent runs.

For the initial run, provide `ISSUER_SEED` in the environment or a local `.env`
file. The seed must match `rfZ1QE8owabXA94HYuKpqZHzRULCGgx16y`.
The issuer seed is not stored in this project.

The initial workflow creates an issuance with `tfMPTRequireAuth` and
`AssetScale: 0`, creates a holder wallet, funds it with 10 test XRP from the issuer,
submits the holder's opt-in, submits the issuer's approval naming `Holder`,
and sends 1,000 MPT units. Holder-to-holder transfers are not enabled.
Each transaction must validate with `tesSUCCESS` before the next step runs.

The final reads use `ledger_entry` for the holder's `MPToken.MPTAmount` and
the issuance's `MPTokenIssuance.OutstandingAmount`, pinned to the same validated
ledger hash. The program verifies authorization and that both amounts equal
`1000`, prints them, and writes the four requested fields to `result.json`.

Files produced:

- `result.json`: issuance ID, holder address, and ledger-read amounts.
- `transactions.json`: validated transaction responses and hashes.
- `ledger-evidence.json`: the ledger snapshot and both ledger entries.
- `.holder.json`: holder address and seed, permission mode 0600 and gitignored.
- `.run-started`: gitignored guard against accidentally repeating a partial run.

If an initial run fails, inspect its transaction receipts and on-ledger state
before retrying. The guard deliberately stops automatic retries that could
duplicate an issuance or payment. Keep `.holder.json` to retain control of the holder.

Protocol references: [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize)
and [sending MPTs](https://xrpl.org/docs/tutorials/payments/send-an-mpt).
