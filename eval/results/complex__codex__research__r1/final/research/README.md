# Research record — 2026-09-29

Research preceded application code. npm's live registry, rather than a cached search result, reported `xrpl` **5.3.0**, published 2026-09-16. `npm view xrpl version dist-tags --json` selected stable `latest`, not an experimental tag. The exact-version [release history](https://github.com/XRPLF/xrpl.js/blob/xrpl%405.3.0/packages/xrpl/HISTORY.md) was read and saved as [xrpl-HISTORY.md](xrpl-HISTORY.md). Version 5.3 adds LendingProtocolV1_1; 5.2 changes entropy validation; 5.1 adds dynamic MPT support; 5.0 changes seed algorithm inference. None requires using amendments disabled on testnet. Wallet.fromSeed correctly derives the supplied issuer address.

All installed direct packages were checked against npm `latest` before installation and pinned: xrpl 5.3.0, TypeScript 7.0.2, tsx 4.23.15, @types/node 26.6.3. Existing runtime: Node 25.9.0, npm 11.12.1. The SDK still takes `Payment.Amount` for transaction construction despite the API-v2 documentation's `DeliverMax` terminology. Validated MPT creation metadata supplies `mpt_issuance_id`. The SDK's root types omit MPToken/MPTokenIssuance exports and its LedgerEntry union omits MPToken; the implementation imports these SDK types directly and specifies the ledger_entry response type.

## Live amendments

The official testnet JSON-RPC endpoint was queried directly before implementation. [testnet-features.json](testnet-features.json) contains the entire response, including enabled and disabled amendment IDs. [live-preflight.json](live-preflight.json) records the demo's later server_info and feature checks with a UTC timestamp. Testnet network ID is **1**, server build **3.4.1**. Runtime checks repeat before setup/attachment.

| Amendment | Enabled | Use |
| --- | --- | --- |
| MPTokensV1 | Yes | Issuance, authorization, balances, locks and payments |
| Clawback | Yes | Holder token removal |
| DepositAuth | Yes | Block direct redemption to issuer |
| DepositPreauth | Yes | Verify no exceptions to issuer deposit policy |
| fixMPTDeliveredAmount | Yes | Present, but demo uses exact payments, no partial payments |
| TokenEscrow | Yes | Deliberately not enabled for this issuance |
| DynamicMPT | No | No mutable capability or ImmutableFlags fields |
| ConfidentialTransfer | No | No confidential features |
| SingleAssetVault | No | No vault dependencies |

The full snapshot is authoritative for all other amendment statuses. Documentation can describe newer functionality than this network supports; capability flags are set at creation. The result does not rely on DynamicMPT.

## Transaction documentation read

| Transaction | xrpl.org reference | Implementation use |
| --- | --- | --- |
| MPTokenIssuanceCreate | [Reference](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate) | Flags 102 = CanLock, RequireAuth, CanTransfer, CanClawback; AssetScale 0; maximum integer supply |
| MPTokenAuthorize | [Reference](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize) | Holder opt-in; issuer approval/revocation; adversarial holder delete/recreate |
| MPTokenIssuanceSet | [Reference](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset) | Lock/unlock; Holder included for individual scope, omitted for global scope |
| Clawback | [Reference](https://xrpl.org/docs/references/protocol/transactions/types/clawback) | MPT amount plus separate Holder; positive integer, saturating amount |
| Payment | [Reference](https://xrpl.org/docs/references/protocol/transactions/types/payment) | Fund wallets with XRP; exact MPT payments and negative tests |
| AccountSet | [Reference](https://xrpl.org/docs/references/protocol/transactions/types/accountset) | SetFlag asfDepositAuth (9) on the dedicated issuer |

The AccountSet/DepositAuth research was completed before introducing that transaction into the implementation, after live lock testing revealed the issuer-payment exception.

## Ledger object documentation read

| Object | xrpl.org reference | Fields/behavior used |
| --- | --- | --- |
| MPTokenIssuance | [Reference](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance) | Issuer, supply, capability flags, global lock, AssetScale |
| MPToken | [Reference](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken) | Balance, Authorized=2, Locked=1, deletion/recreation |
| AccountRoot | [Reference](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot) | Issuer identity/balance and DepositAuth=0x01000000 |
| DepositPreauth | [Reference](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/depositpreauth) | Absence of both account-based and credential-based preauthorization |
| Amendments | [Reference](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments) | Amendment activation model; live status queried through feature RPC |

## Findings that affected the design

[MPT concepts](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens) describes an issuer redemption exception to locking. Live testing also proved that issuer-to-locked-holder minting succeeds. The current [rippled Payment implementation](https://github.com/XRPLF/rippled/blob/develop/src/libxrpl/tx/transactors/payment/Payment.cpp) skips lock checks for payments involving the issuer; this source review is consistent with the observed testnet result, not a claim that develop is the node's exact source revision. We do not label those raw payments as blocked.

[Deposit Authorization](https://xrpl.org/docs/concepts/accounts/depositauth) and the [DepositPreauth ledger entry](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/depositpreauth) were reviewed for a stronger profile: issuer DepositAuth with no preauthorizations blocks holder redemption; application checks block issuer minting while locked. It has an account-wide effect and blocks direct redemption even when unlocked. Live tests return tecNO_PERMISSION on attempted holder redemption. Arbitrary issuer signing remains privileged and must be restricted operationally.

A ban must revoke authorization as well as remove the balance. Simply locking and draining is insufficient because a holder can recreate an empty MPToken entry. We exercise that attack and verify it does not restore authorization. Ban completion checks are based on validated ledger state.
