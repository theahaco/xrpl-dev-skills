# Research completed before implementation

Checked 2026-09-29 against npm registry and XRPL testnet (network ID 1, rippled 3.4.1).

- `npm view xrpl version`: **5.3.0**, published 2026-09-16. [Changelog](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md) is archived in `xrpl-HISTORY.md`. 5.3 adds LendingProtocolV1_1; 5.2 tightens entropy validation; 5.1 adds DynamicMPT/confidential types; 5.0 infers seed algorithms. We use `Wallet.fromSeed`, typed MPT transactions, local signing, and validated metadata. SDK support alone does not establish amendment availability.
- Latest npm TypeScript **7.0.2**, `@types/node` **26.6.3**. Exact direct versions plus full transitive lockfile. No scaffolding/UI dependency is needed for this backend library. Existing Node runtime: 25.9.0; no Node runtime was installed.
- `testnet-features.json` and `testnet-server.json` capture the research-time public RPC responses; `live-preflight.json` captures the execution-time checks. MPTokensV1, Clawback, DepositAuth, DepositPreauth, fixMPTDeliveredAmount and TokenEscrow are enabled. DynamicMPT, ConfidentialTransfer, SingleAssetVault and BatchV1_1 are disabled. No disabled feature is used.
- Reserves observed: 1 XRP base + 0.2 XRP per owned object. Each holder receives 5 XRP; the issuer spends 15 XRP plus transaction fees and reserves one issuance object.

## Transaction documentation read

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): flags 2+4+32+64, integer units, supply limit; omit DynamicMPT-only fields. Scale 0 makes the requested amounts literal ledger balances.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): holder opts in without Holder; issuer authorizes/revokes with Holder; revocation is not clawback. Recreating a holding does not restore issuer authorization.
- [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset): flags 1/2 lock/unlock, Holder for an individual, omit Holder for global lock.
- [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback): MPT Amount requires mpt_issuance_id and separate Holder; a positive amount above balance drains the balance. No AccountSet trust-line-clawback flag is required for MPTs.
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): direct XRP funding and MPT payments; no partial-payment flag, paths or SendMax.
- [AccountSet](https://xrpl.org/docs/references/protocol/transactions/types/accountset): DepositAuth (SetFlag 9) closes the direct-redemption exception for this dedicated issuer.

## Ledger-object documentation read

- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): issuance capabilities, outstanding balance, issuer and sequence.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): MPTAmount, lock bit 1 and authorization bit 2.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): issuer DepositAuth and funding/reserves.
- [DepositPreauth](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/depositpreauth): prohibit both address and credential preauthorizations on the issuer, which would bypass redemption blocking.
- [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments): enabled amendment state; the public feature RPC reports the named enabled status used by preflight.

## Compliance implications

[Native MPT locks](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens) explicitly permit payments back to the issuer. Thus locks alone do not meet a literal no-send/no-movement requirement. [Deposit Authorization](https://xrpl.org/docs/concepts/accounts/depositauth) with no preauthorizations blocks direct redemption payments. This implementation leaves it enabled and tests the restriction live. It applies to the whole issuer account, including normal XRP deposits (subject to the protocol's small-XRP emergency exception), not just this MPT. Use a dedicated issuer and issuer-controlled clawbacks for approved redemption workflows.

Escrow, trading, confidential balances and permissioned domains are not enabled on the issuance. They would add custody/authorization paths beyond this compliance model. Explicit issuer clawbacks remain possible under locks, as required. A global lock halts ordinary movement, not authorized administrative clawback.

SDK 5.3.0 exports ledger types under `LedgerEntry`, and its `AccountObject` union omits `MPToken` despite the API returning it. The adapter explicitly widens the union with the SDK's own `LedgerEntry.MPToken` type.

## Live semantic finding

The frozen-A issuer-payment probe returned **tesSUCCESS**: native locks exempt issuer-originated payments as well as permitting direct redemption. The extra token was clawed back, and all transaction hashes are retained in `transactions.json`. Consequently the issuer module checks current validated global/holder lock flags before every new issuance. This part of freeze enforcement is an issuer-service policy, not a protocol prohibition against an issuer signing independently. DepositAuth blocks the reverse direct-redemption path (live `tecNO_PERMISSION`). A dedicated single signing service is a condition of the stated compliance guarantees.

The live server also omitted `MPTAmount` on C's zero-balance holding. The adapter normalizes the omitted default to string `"0"`; regression coverage preserves this behavior. No zero-balance omission is treated as a remaining balance or an incomplete ban.
