Research completed before implementation on 2026-09-29, against public XRPL testnet.

Versions queried directly with `npm view <package> version`: xrpl 5.3.0, TypeScript 7.0.2, tsx 4.23.15, @types/node 26.6.3. Installed the latest stable tags and pinned exact direct versions in package.json; package-lock.json pins the dependency tree. Existing runtime: Node 25.9.0 (no runtime installed). SQLite uses the Node built-in module.

Read [xrpl release history](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md), saved as xrpl-HISTORY.md. 5.3.0 adds LendingProtocolV1_1 support; 5.2.0 changes entropy validation; 5.0.0 changes seed algorithm inference and MPTAmount typing. We use Wallet.fromSeed, integer string MPT amounts, API v2, and validated transaction metadata. SDK support for a feature does not imply network activation.

Transaction documentation read:

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): create-time capabilities; scale 0, zero transfer fee, maximum 2^63−1. Flags 102 = CanLock + RequireAuth + CanTransfer + CanClawback. Escrow, trade, confidential balances and permissioned domains omitted.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): holder opt-in and separate issuer authorization/revocation. Recreating a holding does not restore authorization.
- [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset): Holder targets an individual; omission targets issuance-wide lock. Flags 1/2 lock/unlock.
- [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback): MPT amount identifies issuance, separate Holder field identifies victim account; amount is positive and clamps to balance.
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): XRP account funding and exact MPT transfers; no partial-payment flag.

Ledger object documentation read:

- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): issuer, capability flags, outstanding supply, scale.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): balance, authorized flag 2, locked flag 1. Lock explicitly permits returning value to the issuer.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): account funding, XRP balance, sequence and owner count.
- [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments): authoritative enabled amendment IDs.

Also read [ledger_entry](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry), [feature](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/feature), [reliable submission](https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission), and [MPT concepts](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens).

Live `feature` and `server_info` responses were saved before implementation. Server 3.4.1, network ID 1; validated ledger 21144257; base reserve 1 XRP and incremental reserve 0.2 XRP. Demo funds 5 XRP per holder, checking that this covers the live reserve and fees. The issuer began with 100 XRP.

Required enabled amendments:

| Name | ID |
| --- | --- |
| MPTokensV1 | 950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38 |
| Clawback | 56B241D7A43D40354D02A9DC4C8DF5C7A1F930D92A9035C4E12291B3CA3E1C2B |

DynamicMPT, ConfidentialTransfer, SingleAssetVault and fixCleanup3_4_0 were disabled. None are prerequisites here. In particular, a lock alone is not a durable ban: without fixCleanup3_4_0, deletion of a zero-balance holding can remove its lock. Revoked issuer authorization remains absent after recreation, as tested by the demo. Runtime preflight independently checks the validated Amendments object and network before signing any new transaction. Full enabled/disabled list is in testnet-features.json; runtime evidence is in runtime-preflight.json.

SDK 5.3.0 has a type-export gap: the root exports omit MPToken and MPTokenIssuance, and the generic LedgerEntry union omits MPToken. The module imports the SDK's actual ledger types from its installed declarations and explicitly types the MPToken response, with runtime entry-type and validation checks.

Live behavioral finding: on this testnet, both individual and global locks permit direct issuer-to-holder Payments as well as holder-to-issuer redemption. The demo records these successful transactions explicitly and removes the extra issued units afterwards. The backend `issue` method checks both lock flags to enforce a stricter issuance policy, but this cannot change native redemption semantics or constrain an independently used issuer key. Do not equate the native lock bit with an absolute no-movement guarantee.

A second live SDK/schema mismatch: rippled omits `MPTAmount` for a zero-balance MPToken object, although xrpl 5.3.0 types it as required. The reader normalizes an absent field to the protocol default `"0"`, validates any present value as a nonnegative integer within range, and has a regression test. This was observed immediately after C's validated clawback.
