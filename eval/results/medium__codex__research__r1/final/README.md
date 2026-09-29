# XRPL testnet MPT example

Strict TypeScript project using xrpl 5.3.0. Creates an MPT requiring issuer approval,
funds a new holder with 10 test XRP from the supplied issuer, has the holder opt in,
approves that holder, and issues 1,000 whole tokens (`AssetScale: 0`). The maximum
supply is 1,000. Holder-to-holder transfers are not enabled.

```sh
npm ci
npm run build
# For a fresh run, set ISSUER_SEED in the environment or an ignored .env file.
npm start
# Read and verify the existing result without sending transactions:
npm run verify
```

The issuer must be `rpiVYqiq6JUj2MwMLtnut5qjX5FQ2Ck1gV`. The endpoint is fixed to
XRPL testnet. The issuer seed is not saved in source. The generated holder's seed
is in ignored `holder-wallet.json` (owner-only file permissions); keep it to use
the holder later.

`result.json` contains balances read from `MPToken.MPTAmount` and
`MPTokenIssuance.OutstandingAmount` at the same validated ledger index.
`verification.json` preserves the ledger responses. `transactions.jsonl` records
prepared transaction hashes and validated results. Every transaction must validate
with `tesSUCCESS`, and verification checks both authorization flags and balances.

Issuing again is intentionally blocked when a previous run's wallet or journal
exists. If interrupted, inspect the recorded hashes on testnet before taking
further action; this example does not automatically resume partially completed runs.
Use a separate directory for a new issuance. Testnet state lasts until a network reset.

## Research before implementation

The npm registry reported these latest stable releases: `xrpl` **5.3.0**,
`typescript` **7.0.2**, and `@types/node` **26.6.3**. All installed direct
dependencies are pinned, with a lockfile. Existing Node 25.9.0 and npm 11.12.1
were used; no additional runtime or runner was installed.

Read the [5.3.0 release changelog](https://github.com/XRPLF/xrpl.js/releases/tag/xrpl%405.3.0):
the release adds Lending Protocol V1_1 support. The installed SDK's current types
and methods were also checked. Its `LedgerEntry` union omits `MPToken`, so the
holder response is checked at runtime; no `any` is used.

Transaction documentation reviewed:

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): `tfMPTRequireAuth` (4), scale, maximum supply.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): holder opt-in omits `Holder`; issuer approval includes it.
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): XRP account funding and direct MPT issuance payments.

Ledger object documentation reviewed:

- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): `MPTAmount` and `lsfMPTAuthorized` (2).
- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): `OutstandingAmount` and required authorization flag.
- [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments): enabled amendment IDs.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): accounts created by XRP funding.
- [ledger_entry API](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry): direct MPT lookups.

Queried testnet directly before writing implementation code. The complete responses
are in `research/amendments.json` (validated ledger) and `research/features.json`
(names and status). The required
[MPTokensV1 amendment](https://xrpl.org/resources/known-amendments#mptokensv1), ID
`950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38`, is enabled.
These operations rely only on that MPT amendment and ordinary XRP payments.
No permissioned domain, dynamic MPT, confidential transfer, escrow, or DEX feature
is used. The program rechecks the validated amendment object before submitting
and saves it in `research/run-amendments.json`.
