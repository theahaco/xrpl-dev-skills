# XRPL testnet MPT example

Small strict TypeScript project using the npm `xrpl` package. It funds a new holder
with 10 test XRP from the supplied issuer, creates an MPT with `RequireAuth`, opts
the holder in, approves it from the issuer account, and sends 1,000 tokens.
`AssetScale: 0` makes each ledger unit one whole token. `CanTransfer` also permits
transfers between approved holders. No permissioned domain is configured.

```sh
npm ci
npm run check
ISSUER_SEED='<testnet issuer seed>' npm start
```

The issuer must be `rPrQskvFacjRfzF9cXsHTfuPXSQVwx5U8`. The endpoint is fixed to
`wss://s.altnet.rippletest.net:51233`. Each transaction must validate with
`tesSUCCESS` before the next step proceeds. The issuer seed is read from the
environment and is not saved by the project.

After this project's completed run, refresh the ledger balances without sending
transactions or supplying a seed:

```sh
npm run read
```

Files produced:

- `result.json`: issuance ID, holder address, holder balance, and outstanding supply.
- `ledger-evidence.json`: both ledger entries read at the same validated ledger hash.
- `transactions.jsonl`: validated transaction hashes and metadata.
- `issuance.json`: issuance and holder identifiers, saved before authorization.
- `.holder.json`: generated holder address and seed (mode 0600, ignored by Git).
- `.run-started`: prevents accidentally repeating the issuance workflow.

Keep `.holder.json` to control the holder. A failed run leaves its transaction
evidence and marker in place; inspect these before manually recovering. Running
`npm start` again refuses to create another issuance while the marker exists.
Testnet data remains subject to testnet resets.

Protocol references: [MPT creation](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate)
and [holder opt-in and issuer authorization](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize).
