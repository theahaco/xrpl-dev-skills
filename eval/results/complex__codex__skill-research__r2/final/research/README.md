# Pre-implementation research — 2026-09-29

Research was completed before writing application code. npm registry `npm view ... version` reported:

| Direct package | Latest stable version installed |
|---|---|
| xrpl | 5.3.0 |
| typescript | 7.0.2 |
| tsx | 4.23.15 |
| @types/node | 26.6.3 |

All direct versions are exact-pinned; package-lock.json pins the dependency graph. No scaffolder or frontend dependencies were installed for this backend. Existing runtime: Node 25.9.0, npm 11.12.1. Node's built-in SQLite, crypto and test facilities avoid additional dependencies.

Read [official SDK release history](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md): 5.3 adds lending support; 5.2 tightens entropy validation; 5.0 infers signing algorithm from seed prefixes. We use Wallet.fromSeed, Wallet.generate, autofill, local signing, submitAndWait, and validated metadata. SDK support for a feature is not evidence of network activation. The SDK's top-level ledger type union omits MPToken; a narrow local cast bridges this declaration gap after a runtime LedgerEntryType check. Live rippled omits MPTAmount when zero despite the SDK declaring it required; holder reads normalize this omission to the protocol default of zero.

## Transaction pages read

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): creation flags 2 + 4 + 32 + 64 = 102; locking, authorization, peer transfer and clawback. AssetScale 0, string integer amounts. Do not enable escrow, trading or confidential balances. No DynamicMPT fields.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): holder opt-in is distinct from issuer approval; issuer uses Holder. Unauthorize flag 1 revokes issuer approval, or deletes an empty holding when submitted by the holder.
- [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset): lock flag 1, unlock flag 2; Holder selects one holding, omission selects the entire issuance. Use original MPTokensV1 functionality only.
- [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback): MPT Amount uses mpt_issuance_id and value, with a separate Holder. Values above the current balance reclaim the available balance. A zero balance cannot be clawed back.
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): XRP payments activate accounts, MPT payments mint/transfer/redeem tokens. No partial-payment flags, paths or SendMax are used.

## Ledger object pages read

- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): verify Issuer, capabilities, OutstandingAmount and global lock.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): read integer MPTAmount, authorized flag 2, locked flag 1.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): funded XRP balance, OwnerCount and transaction sequence.
- [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments): enabled amendment hashes, read from a validated ledger at runtime.

Supporting references: [MPT concepts and lock exception](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens), [ledger_entry](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry), [feature](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/feature), [XLS-33](https://xls.xrpl.org/xls/XLS-0033-multi-purpose-tokens.html).

## Live testnet confirmation

Pre-code RPC snapshots are stored in testnet-features.json and testnet-server-info.json. The endpoint was https://s.altnet.rippletest.net:51234; rippled 3.4.1, network ID 1, validated ledger 21144397, reserve base 1 XRP and increment 0.2 XRP.

Enabled: MPTokensV1, Clawback, fixMPTDeliveredAmount, TokenEscrow, PermissionedDomains. Disabled: DynamicMPT, ConfidentialTransfer, SingleAssetVault, fixCleanup3_4_0, BatchV1_1. The full named list, including all enabled/disabled statuses, is in testnet-features.json. Runtime preflight independently hashes required amendment names using SHA-512Half and checks the validated Amendments object before signing.

A critical distinction: MPT locking exempts direct issuer payments. Live testnet additionally demonstrated issuer-to-frozen-holder issuance, broader than the concepts page wording. Neither local nor global locks implement an absolute ban on balance changes. The demo proves both directions under local and global locks, balancing one token of issuance with one token of redemption in each case. The module adds an issuance guard. The implementation must not be described to compliance as providing absolute immobilization. Clawback also necessarily changes balances under a lock.

Bans use durable issuer policy plus revocation and full clawback. Revocation persists as absence of authorization even if a holder deletes/recreates its empty MPToken. No protocol flag permanently prevents the issuer itself from reauthorizing an address; exclusive control of signing and the retained policy store is part of the enforcement boundary.
