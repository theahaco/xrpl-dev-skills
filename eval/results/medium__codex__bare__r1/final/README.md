# XRPL testnet MPT demo

A strict TypeScript project using the npm `xrpl` package. The endpoint is fixed to
`wss://s.altnet.rippletest.net:51233` and the issuer address is checked against the
provided seed.

```sh
npm ci
npm run check
ISSUER_SEED='<your testnet issuer seed>' npm start
```

The script creates an MPT with required issuer authorization, allows transfers
between approved holders, and sets `AssetScale: 0` and a maximum supply of 1,000.
It generates a holder, sends it 10 test XRP from the issuer, submits the holder's
opt-in, submits the issuer's approval, then pays the holder 1,000 MPT units.
Every transaction must be validated with `tesSUCCESS` before continuing.

`result.json` contains the requested four fields. The balances come from
`MPToken.MPTAmount` and `MPTokenIssuance.OutstandingAmount`, queried at the same
validated ledger hash. `ledger-evidence.json` preserves both ledger responses.
Read the balances again without a seed or any new transactions:

```sh
npm run balances
```

The holder seed and signed transaction journal are stored in `.local/state.json`
with owner-only file permissions and excluded from git. The issuer seed is read
from the environment and is not saved. Preserve `.local/state.json` to retain
control of the holder and resume the same run. Re-running `npm start` looks up
saved transaction hashes before submitting, so successful steps are not repeated.
If a saved transaction expired without validation, the script stops; inspect its
hash and ledger status before changing the journal. Removing the journal starts
a new issuance and funds a new holder.

Protocol references:
- [MPT issuance](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate)
- [Holder opt-in and issuer approval](https://xrpl.org/docs/tutorials/payments/send-an-mpt)
- [Ledger entry queries](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry)
