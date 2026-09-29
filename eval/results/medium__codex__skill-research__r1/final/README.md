# XRPL testnet MPT example

Strict TypeScript example using `xrpl` 5.3.0. Creates an issuer-approved MPT,
funds a new holder with 5 test XRP, opts the holder in, grants issuer approval,
and sends 1,000 whole tokens (`AssetScale: 0`). Only approved accounts can hold
tokens. Holder-to-holder transfers are not enabled.

```sh
npm ci
npm run check
npm run build
# For a fresh run, supply the issuer's testnet seed through the environment:
ISSUER_SEED='<testnet seed>' npm start
# Read and verify the completed run again, without a seed or transactions:
npm run verify
```

The issuer address is fixed to `rMCnv6DVfXrFfZsqPq9kqVAeGkVLAdn8wz` and the
endpoint is fixed to XRPL testnet. The script checks network ID 1 and the live
MPTokensV1 amendment before submitting. It signs locally, autofills fees,
sequence and expiration, caps fees at 0.01 XRP per transaction, and checks every
validated transaction for `tesSUCCESS`.

`result.json` contains the requested output. `ledger-evidence.json` contains
the two ledger responses from the same validated ledger hash, including
the issuer's require-authorization flag and the holder's authorization flag.
`receipts/` contains validated transaction responses.

The holder seed is saved in `.local/holder.json` (mode 0600, ignored by Git).
The issuer seed is not stored. A second issuance run is deliberately blocked
once a holder has been generated. If interrupted, inspect `.local/` and receipts
and resolve pending transaction hashes before taking further action; the script
does not automatically restart a partially completed issuance.

Funding spends 5 test XRP from the issuer, plus transaction fees. Live reserves
at research time were 1 XRP per account plus 0.2 XRP per owned object. Both the
issuance and the holder's MPToken entry consume owner reserve. These are testnet
assets and may disappear at a testnet reset.

See [research notes](research/README.md) for release and protocol sources.
