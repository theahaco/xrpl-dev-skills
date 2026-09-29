# XRPL Testnet MPT demo

Strict TypeScript project using `xrpl` 5.3.0. The issuer is
`rEyNWbgPq7jnWYa7dnWPVtsHZxroy3XGVd`; the endpoint is hardcoded to XRPL Testnet
and the script checks network ID 1 before submitting transactions.

The script funds a new holder with 10 test XRP, creates an MPT with
`tfMPTRequireAuth | tfMPTCanTransfer` (36), has the holder opt in, approves that
holder from the issuer, and sends 1,000 units. AssetScale is 0. Holder-to-holder
transfers are permitted, but recipients must also be approved by the issuer.

```sh
npm ci
npm run check
export ISSUER_SEED='<your testnet seed>'
npm start
```

The completed run is already recorded in this directory. `npm start` refuses to
run again when `transactions.json` exists, to prevent duplicate issuance. If a
run is interrupted, inspect the recorded transaction hashes before taking any
further transaction action; the program does not automatically resume writes.

To read the existing token balances again, without a seed or new transactions:

```sh
npm run verify
```

Verification reads `MPToken.MPTAmount` and `MPTokenIssuance.OutstandingAmount`
at the same validated ledger hash, checks the approval flags, and asserts both
amounts are exactly `"1000"`. If you later change the balances, those assertions
will need updating.

Files produced:

- `result.json`: the four requested fields, with amounts read from the ledger.
- `issuance.json`: issuance ID and holder address for subsequent verification.
- `transactions.json`: hashes, transaction fields, validation results and metadata.
- `ledger-evidence.json`: the ledger hash/index and full balance query results.
- `.secrets/holder.json`: the generated holder's address and seed, mode 0600,
  excluded from Git. The issuer seed is supplied through the environment only.
- `research/`: pre-implementation research and amendment evidence.

No faucet dependency is needed. The issuer pays the 10 test XRP funding payment
and its own transaction fees/reserves; the holder pays its opt-in fee/reserve.
Testnet resets can remove these ledger objects.
