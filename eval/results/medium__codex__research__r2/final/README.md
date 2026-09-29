# Testnet MPT example

Strict TypeScript project using xrpl 5.3.0. Creates an authorization-required MPT from `rE93cZ289p6yHdZ68UQZR26jbCPG6rbzQx`, funds a generated holder with 5 test XRP, registers the holder, approves it from the issuer, and sends 1,000 tokens. AssetScale is 0. Holder-to-holder transfers are disabled; holders may return tokens to the issuer.

```sh
npm ci
npm run build
ISSUER_SEED='<testnet issuer seed>' npm start
```

The completed run is already recorded in `result.json`. To read and verify it again without issuing or sending anything:

```sh
npm run verify
```

`result.json` contains strings read from the validated MPToken and MPTokenIssuance objects at one ledger index. Runtime checks enforce the issuer, authorization flags, holder issuance ID, and both expected balances. Transactions must validate with `tesSUCCESS` before execution continues.

`01-*.json` through `05-*.json` contain transaction receipts; `transactions.jsonl` records hashes before submission; `ledger-evidence.json` contains the final ledger responses; `amendments.json` records the network and full feature snapshot.

The generated holder seed is saved in `.holder.json` with owner-only permissions and excluded from git. The issuer seed is read from the environment. `.run-started` prevents accidental duplicate runs. If interrupted, inspect the recorded transaction hashes and receipts before deciding how to recover; the script does not automatically resume or resubmit.

See [RESEARCH.md](RESEARCH.md) for the pre-implementation research.
