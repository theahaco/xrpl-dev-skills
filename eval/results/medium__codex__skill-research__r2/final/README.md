# XRPL Testnet MPT example

A strict TypeScript CLI using xrpl 5.3.0. It funds a fresh holder with 2 test XRP, creates an MPT requiring issuer approval, has the holder opt in, approves the holder, and issues 1,000 whole tokens. It then reads MPTAmount and OutstandingAmount from the same validated ledger, checks both are 1000, and writes result.json.

## Run

Use Node.js 22 or newer (tested with 25.9.0).

```sh
npm ci
npm test
# Set ISSUER_SEED to the supplied testnet seed in your environment,
# or put ISSUER_SEED=... in a local .env file.
npm start
```

After a completed run, `npm start` only reads and verifies the existing result. A seed is not needed for read-only verification:

```sh
npm run build
npm run verify
```

The issuer is fixed to `rhFHiXkJAN7p6Un4dZ47NLU5zFhbVV4akK`, and the endpoint and network ID are checked for testnet. The issuer seed is never written by the program. The generated holder's seed is saved in `.secrets/holder.json` (ignored by Git, file mode 0600), so you retain control of the holder.

## Artifacts and recovery

- `result.json`: requested four fields, populated from ledger reads.
- `ledger-snapshot.json`: raw ledger responses and validated ledger hash.
- `receipts/`: five validated transaction receipts plus amendment/reserve preflight.
- `RESEARCH.md` and `research/`: research sources and live amendment evidence.
- `.secrets/`: holder credentials and signed transaction checkpoints; keep private.

Transactions are signed locally with an autofilled sequence, fee, and LastLedgerSequence. The program requires validated tesSUCCESS, and saves signed transactions before submitting. On interruption, rerun with the issuer seed: completed receipts are reused, and pending hashes are checked before resubmission. If a pending transaction has expired without validation, the program stops; inspect its hash and receipt before any manual recovery. Do not delete checkpoints or run concurrent copies while a transaction is pending.

## Behavior and costs

Only approved holders can receive this MPT. New holders must opt in and receive issuer approval. Holder-to-holder transfers, trading, escrow, and clawback capabilities are not enabled. The issuer can issue further supply; no maximum was configured.

The holder receives 2 test XRP from the issuer. At execution, reserves were 1 XRP per account and 0.2 XRP per owned object. Each account gains one owned object; the holder therefore needs 1.2 XRP reserved. Transaction fees are autofilled and capped at 0.01 XRP each. Testnet state can be reset.

`npm test` checks strict compilation, SDK validation, serialization round trips, and signing. The live run and `npm run verify` check validated transactions, authorization flags, and actual balances. xrpl 5.3.0 omits MPToken from its public ledger-entry union, so the readback uses a narrowly scoped structural type with runtime checks.
