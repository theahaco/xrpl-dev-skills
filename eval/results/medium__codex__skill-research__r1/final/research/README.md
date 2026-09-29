# Research completed before implementation — 2026-09-29 UTC

The npm registry (`npm view <package> version`) reported the following latest
stable versions, installed exactly and recorded in package-lock.json:

| Package | Version |
| --- | --- |
| xrpl | 5.3.0 |
| typescript | 7.0.2 |
| tsx | 4.23.15 |
| @types/node | 26.6.3 |

Used the existing Node 25.9.0 and npm 11.12.1; no runtime was installed.

Read the [xrpl release history](https://github.com/XRPLF/xrpl.js/blob/xrpl%405.3.0/packages/xrpl/HISTORY.md)
and [5.3.0 release](https://github.com/XRPLF/xrpl.js/releases/tag/xrpl%405.3.0).
5.3.0 adds LendingProtocolV1_1 support. Relevant preceding changes include
seed-prefix algorithm inference in 5.0 and MPT type/API additions in 5.1.
The tagged changelog is saved as `xrpl-HISTORY.md`.

Read these xrpl.org protocol pages for all transaction and ledger entry types
directly used by this example:

- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): XRP account funding and direct MPT delivery, with no partial-payment flag.
- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): `tfMPTRequireAuth = 4`, `AssetScale = 0`.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): holder opt-in without `Holder`, followed by issuer approval with `Holder`.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): string `MPTAmount` balance and `lsfMPTAuthorized = 2`.
- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): string `OutstandingAmount` circulation and require-auth flag.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): XRP balance and owner count for reserve checks.
- [ledger_entry](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry): MPT lookup by issuance ID and holder; issuance lookup by ID.

Queried the live testnet JSON-RPC endpoint
`https://s.altnet.rippletest.net:51234/` using `feature` and `server_info`.
Raw responses are saved in `testnet-features.json` and
`testnet-server-info.json`; the script also saves a fresh `run-features.json`.
The full feature response lists the enabled and disabled amendments by name
and amendment ID. MPTokensV1 is enabled:
`950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38`.
DynamicMPT and ConfidentialTransfer are disabled; neither is required or used.
No permissioned domains, DEX, escrow, or confidential-transfer APIs are used.
Server reported rippled 3.4.1, network ID 1, and reserves of 1 XRP + 0.2 XRP/object.

Implementation compatibility note: xrpl 5.3.0's generic `LedgerEntry` response
union omits MPToken, so the script validates the returned object's discriminant
and required fields at runtime without an unchecked type assertion.
