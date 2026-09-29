# XRPL testnet MPT demo

Small TypeScript project with `strict: true` and the npm `xrpl` SDK. It uses only
`wss://s.altnet.rippletest.net:51233` and checks network ID 1 before submitting.

The script creates an MPT with `tfMPTRequireAuth | tfMPTCanTransfer` and
`AssetScale: 0`, funds a new holder with 5 test XRP (or more if current reserves
require it), submits the holder's opt-in, authorizes it from the issuer, and
sends exactly 1,000 tokens. The maximum supply is 1,000,000 tokens.

Holder approval uses MPT-specific authorization, as described in the official
[MPTokenAuthorize reference](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize).
The issuance's [RequireAuth flag](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate)
restricts holdings to approved accounts.

```sh
npm ci
npm run build
npm test

# Read the existing result back from testnet; no seed or transactions needed:
npm run verify
```

For the initial issuance in a fresh directory, supply `XRPL_ISSUER_SEED` through
the environment and run `npm start`. It must derive the configured issuer
`r4qjkCwSs5LcYLNuDHL9C7mGdMHcg37z36`. The issuer seed is not stored by this project.

`npm start` creates `.run-started` exclusively and refuses to run again, preventing
accidental duplicate issuance or payment. If interrupted, inspect
`transactions.jsonl` and look up its transaction hashes before attempting recovery;
do not simply remove the marker and rerun. Queued transactions are handled by
the SDK's validation polling; a rejected past sequence is refreshed once.

Files:

- `src/index.ts`: submission, reserve checks, holder setup, and ledger verification.
- `src/transactions.ts`: issuance and token payment builders.
- `src/transactions.test.ts`: signing/serialization checks for authorization and amounts.
- `result.json`: requested four-field result, using ledger-returned decimal strings.
- `ledger-proof.json`: both raw ledger entries from one validated ledger hash.
- `transactions.jsonl`: prepared transaction hashes and validated responses.
- `.holder.json`: holder address and seed, saved with mode 0600 and ignored by Git.

Verification checks the issuer, RequireAuth, holder authorization, and that both
`MPTAmount` and `OutstandingAmount` equal `"1000"`. It reads entries using
[`ledger_entry`](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry),
rather than inferring balances from the payment. It will fail if the balances
have subsequently changed.

Risk notes: all signing is local. Transactions spend testnet XRP fees; funding
moves test XRP from the issuer to the holder. At execution time, reserves were
1 XRP per account and 0.2 XRP per owned object; the issuance and holder entry each
add one owned object. Preserve `.holder.json` if you want to operate the holder.
Testnet data can be reset by the network.
