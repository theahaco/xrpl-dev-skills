# XRPL testnet MPT demo

Small strict TypeScript project using `xrpl`. It funds a new holder with 5 test
XRP from the supplied issuer, creates an MPT with `tfMPTRequireAuth`, opts the
holder in, approves the holder from the issuer, and sends 1,000 tokens.
`AssetScale: 0` makes each ledger unit one whole token. Holder-to-holder
transfers are enabled, subject to issuer authorization of recipients.

```sh
npm ci
npm run build
export ISSUER_SEED='<your testnet issuer seed>'
npm start
```

The issuer must be `rfWb2bXAar5BKcGcTwfqpTQaF4rXnuQ59N`. The endpoint is fixed
to `wss://s.altnet.rippletest.net:51233`; the script also checks network ID 1.

The script waits for validated `tesSUCCESS` on every transaction, then reads
the holder's `MPToken.MPTAmount` and the issuance's
`MPTokenIssuance.OutstandingAmount` from the same validated ledger. It checks
both authorization flags and both amounts, prints the result, and writes:

- `result.json`: issuance ID, holder address, and the two ledger balances.
- `verification.json`: ledger snapshot, transaction hashes, and ledger entries.
- `.mpt-state.json`: private local holder seed and transaction checkpoints
  (gitignored, mode 0600). Keep this file to retain control of the holder.

Rerunning with the same state skips successful transactions and refreshes the
ledger reads. Signed transactions are saved before submission; after an
interruption, the script looks up their hashes before resubmitting the same
blob. It never automatically creates a replacement for an expired or failed
transaction. Investigate such failures before changing state. Keep the state
file; removing it starts another issuance and funds another holder. Run only
one instance at a time, from the project root.

Signing happens locally. The issuer seed comes only from the environment and
is not saved. Transactions consume test XRP fees; the holder receives 5 XRP.
Account and object reserves are checked against live server settings and keep
part of each account's XRP unavailable while the objects exist. This run used
1 XRP base reserve and 0.2 XRP per owned object.

Validation: `npm run check` checks strict typing; `npm run build` emits runnable
JavaScript (`node dist/index.js`). The live run verifies validated transaction
results, authorization flags, and exact ledger amounts. Transaction evidence is
in `verification.json`.

Protocol references: [MPT creation](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate),
[holder authorization](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize),
and [MPToken fields](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken).
