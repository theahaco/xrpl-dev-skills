# XRPL testnet MPT example

Small strict-mode TypeScript project using the npm `xrpl` package. The endpoint
is fixed to XRP Ledger testnet. Requires Node.js 22 or newer.

```sh
npm ci
npm run check
ISSUER_SEED='<testnet issuer seed>' npm start
```

The issuer must be `rhourKNgQvkTMr268W2rMBXdt3YiBBCZxf`. The script generates a
holder, funds it with 10 test XRP from the issuer, creates an MPT with
`tfMPTRequireAuth` and `tfMPTCanTransfer`, submits the holder's opt-in and then
the issuer's approval, and sends 1,000 units. `AssetScale: 0` means whole tokens.
Every transaction must be validated with `tesSUCCESS` before proceeding.

The final two `ledger_entry` requests use the same validated ledger hash.
`result.json` contains `MPTAmount` from the holder's `MPToken` and
`OutstandingAmount` from the `MPTokenIssuance`, both retained as decimal strings.
The script also verifies the issuance requires approval and the holder is approved.

To read the existing balances again without submitting any transactions:

```sh
npm run read
```

`holder-wallet.json` preserves the holder's seed locally, is created with mode
0600, and is ignored by Git. The issuer seed is supplied only through the
environment. `issuance.json` records the issuance and holder identifiers, and
`transactions.jsonl` records validated transaction hashes and ledger indices.
Keep these files if a run is interrupted. The script refuses to create another
issuance while `holder-wallet.json` exists; do not delete it to retry a partially
completed run, because that would create another holder and issuance.

Protocol references: [MPT creation](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate)
and [holder opt-in and issuer approval](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize).
