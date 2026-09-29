# XRPL testnet MPT demo

Small strict-mode TypeScript CLI using `xrpl`. It funds a new holder with 5 test XRP, creates an MPT requiring issuer approval, has the holder opt in, approves that holder, sends 1,000 whole tokens, then queries both balances from one validated ledger snapshot.

```sh
npm ci
npm run build
# For an initial run in a fresh checkout:
ISSUER_SEED='<testnet issuer seed>' npm start
# Read the existing issuance again; requires no seed and submits no transactions:
npm run read
```

The issuer is `rnW24ustzaxhYDKYj36XWZ79MGpFRgR3SP`. The endpoint is fixed to `wss://s.altnet.rippletest.net:51233`, and the CLI checks network ID 1 before proceeding.

`tfMPTRequireAuth` restricts holdings to accounts the issuer approves. Holder opt-in and issuer approval are separate `MPTokenAuthorize` transactions. AssetScale is 0 and MaximumAmount is 1,000,000. Other optional capabilities, including secondary holder-to-holder transfers, are disabled. See the official [issuance flags](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate) and [holder authorization](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize).

Outputs:

- `result.json`: issuance ID, holder address, and ledger-read balance and outstanding supply as strings.
- `transactions.json`: successful validated transaction hashes and ledger indexes.
- `ledger-proof.json`: raw ledger entries and the validated snapshot hash.
- `.local/holder.json`: generated holder address and seed, mode 0600 and Git-ignored. Keep this file to control the holder account.

Signing happens locally. The issuer seed is supplied through the environment and is not saved. Fees, sequence numbers, and LastLedgerSequence are autofilled. Every transaction must validate with `tesSUCCESS`. Current reserve requirements are checked before spending; at execution they were 1 XRP per account and 0.2 XRP per owned object. The issuer and holder each acquire one MPT object, and transactions consume small XRP fees.

The initial run creates `.local/run.lock` to prevent accidental duplicate issuance. If execution is interrupted, inspect `transactions.json`, `.local/pending.json`, and the pending transaction's ledger status before any manual retry. Do not remove the lock and blindly restart: an earlier payment may already have succeeded. Queued transactions are tracked by `submitAndWait`; ambiguous timeouts and sequence failures stop the script for reconciliation.

Validation: `npm run build` performs strict type checking. The live run checks every transaction result, the issuance authorization flag, the holder authorization flag, and final balances of exactly `1000`. `npm run read` independently refreshes ledger state without creating another token.
