# XRPL testnet MPT example

Small strict TypeScript project using the npm `xrpl` SDK. It funds a generated
holder with 5 test XRP from the supplied issuer, creates an MPT with
`tfMPTRequireAuth`, opts the holder in, approves it from the issuer, and sends
1,000 whole tokens (`AssetScale: 0`). Holder-to-holder transfers are enabled,
but recipients must also be approved by the issuer. Maximum supply is 1,000,000.

```sh
npm ci
npm run build
# For a fresh run in a directory without previous run artifacts:
export ISSUER_SEED='<your testnet issuer seed>'
npm start
# Read the existing issuance again without submitting any transactions:
npm run read
```

The issuer address is fixed in `src/index.ts`. The endpoint is fixed to
`wss://s.altnet.rippletest.net:51233`, and the script checks network ID 1.
The issuer seed is read only from the environment; signing happens locally.
The generated holder's seed is saved in `.holder.json`, ignored by Git and
created with owner-only file permissions. Keep that file to control the holder.

`result.json` contains balances read from `MPToken.MPTAmount` and
`MPTokenIssuance.OutstandingAmount` in the same validated ledger. The script
also checks that issuance authorization is required and the holder is approved.
`ledger-evidence.json` preserves the ledger snapshot; `transactions.json`
records all five successful transaction hashes and ledger indexes.
`issuance.json` supplies identifiers for subsequent read-only runs.

Every transaction uses an autofilled fee, sequence, and LastLedgerSequence,
and must finish validated with `tesSUCCESS`. Errors stop execution. The SDK
waits for final validation, including queued transactions. The script refuses
to rerun issuance if `.holder.json` already exists to prevent accidental
duplicate issuance/payments. After an interruption, inspect
`pending-transaction.json` and query its hash before attempting recovery;
the script does not blindly resubmit or automatically resume partial runs.

The completed live run serves as the integration check, including assertions
that both balances are `1000`; `npm run build` checks strict TypeScript.

Costs: the holder receives 5 test XRP and transaction fees are charged to each
signing account. Current reserves are queried before transactions (1 XRP base
and 0.2 XRP per object at execution). The issuer owns an issuance object and
the holder owns a holding object, each adding an owner reserve requirement.

Protocol references:
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize)
- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance)
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken)
