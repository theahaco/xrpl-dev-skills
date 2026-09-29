# Research record — 2026-09-29 UTC

Research preceded implementation. `npm view xrpl version dist-tags --json` returned latest stable **5.3.0**, published September 16, 2026. Experimental tags were not selected. The upstream [release history](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md) is archived in `xrpl-HISTORY.md`. Relevant changes: 5.3 adds lending support; 5.1 adds DynamicMPT/confidential transfers; 5.0 infers signing algorithm from seed prefixes and corrects MPTAmount to string. This project uses Wallet.fromSeed, Client.autofill, locally signed blobs, submitAndWait, typed transactions and explicit validated ledger reads. The SDK has an incomplete public MPToken type export/ledger union, so two type-only imports use its pinned internal declarations and the holder query supplies an explicit response type.

Other direct packages were checked using npm's registry before installation: TypeScript 7.0.2, tsx 4.23.15, @types/node 26.6.3. Exact direct versions and the dependency graph are locked. Node v25.9.0 and npm 11.12.1 were preinstalled, not installed by this task.

## Documentation read

Transactions:

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): creation-time capabilities, integer maximum, AssetScale, no reliance on DynamicMPT fields.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): holder opt-in is separate from issuer authorization; issuer uses Holder; unauthorize revokes approval.
- [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset): lock/unlock, Holder omitted for global lock.
- [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback): MPT Amount plus Holder; positive amount; oversized request drains available balance.
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): XRP account funding and direct MPT payments. No partial payments or paths.
- [AccountSet](https://xrpl.org/docs/references/protocol/transactions/types/accountset): asfDepositAuth (9), used to close the return-to-issuer freeze exception.

Ledger objects:

- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): issuer, capabilities, outstanding amount, global lock.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): integer balance, authorization and individual lock.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): issuer address, balance, sequence and DepositAuth flag.
- [DepositPreauth](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/depositpreauth): ensure no account or credential preauthorizations bypass strict redemption blocking. No such objects are created.

Also read [MPT concepts](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens), [Deposit Authorization](https://xrpl.org/docs/concepts/accounts/depositauth), and the upstream MPTokenAuthorize implementation to distinguish amendment-gated deletion semantics.

## Live testnet evidence

`docs/testnet-features.json` contains the full `feature` response from `https://s.altnet.rippletest.net:51234`, queried before code was written. Runtime also checks network_id=1 and required amendments on every connection.

| Amendment | Enabled | Use |
| --- | --- | --- |
| MPTokensV1 | yes | MPT transactions and objects |
| Clawback | yes | Holder clawback |
| DepositAuth / DepositPreauth | yes | Block direct returns to issuer |
| fixMPTDeliveredAmount | yes | Correct MPT delivered amount metadata |
| DynamicMPT | no | Not used; flags chosen at creation |
| ConfidentialTransfer | no | Not used |
| fixCleanup3_4_0 | no | Do not rely on locked empty holdings being undeletable |
| SingleAssetVault | no | Not used |

Capabilities = 102: CanLock (2), RequireAuth (4), CanTransfer (32), CanClawback (64). Escrow, trading, confidential balances and permissioned domains are not enabled. AssetScale=0 makes the requested 500 and 700 balances literal ledger units.

Native MPT locks permit direct returns to the issuer. To satisfy strict payment freezes this dedicated issuer has DepositAuth enabled permanently with no preauthorizations. This blocks incoming Payments for all of its tokens, including while unfrozen. Administrative clawbacks remain possible during locks by design. No code can prevent a holder of issuer signing authority from changing controls. Compliance policy and signing authority must be secured together.

A ban is a multi-transaction process, not atomic: persist deny policy, lock, revoke authorization, claw back, verify. Completion is reported only after zero balance and no authorization. Revocation is essential: on this testnet a banned holder can delete/recreate an empty MPToken but cannot recreate the issuer's authorization.

## Live finding during implementation

An issuer-to-locked-holder Payment succeeded (`7BCFA88767F1500BD366B72957E8ADA8B505E7AE68AF1B6B2DAA67978D54128C`), contrary to a literal reading of the conceptual freeze description. The demo reverses this one-unit probe with clawback. `issue` therefore checks validated global/holder locks and authorization before signing. This is issuer signing policy, not an additional ledger restriction; a holder cannot bypass it without issuer signing authority. The strict freeze guarantee requires exclusive issuer key control. Raw issuer payments must not bypass the module.

After full clawback, rippled omitted `MPTAmount` from C's MPToken JSON. The SDK declares that field required. The ledger adapter normalizes the omitted zero field to `"0"`; the recovery test includes this actual response shape.
