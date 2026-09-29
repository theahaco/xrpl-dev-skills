# Research completed before implementation — 2026-09-29

Registry queries (`npm view <package> version`) returned:

| Direct package | Latest stable used |
| --- | --- |
| xrpl | 5.3.0 |
| typescript | 7.0.2 |
| @types/node | 26.6.3 |

Exact versions and transitive dependencies are locked in package-lock.json. Existing runtime: Node 25.9.0, npm 11.12.1; neither runtime was installed by this task. No other tools/packages were installed. SQLite and the test runner are Node built-ins.

Sources read:

- [npm registry](https://registry.npmjs.org/xrpl/latest), checked directly with npm rather than relying on the stale npm search snippet.
- [xrpl.js changelog](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md): 5.3.0 adds LendingProtocolV1_1; 5.2.0 tightens Wallet.fromEntropy; 5.0.0 infers Wallet.fromSeed algorithm from seed prefix. Use Wallet.generate/fromSeed, Client.autofill, wallet.sign, Client.submitAndWait, and validated transaction metadata. No lending/confidential/dynamic MPT API is required here.

All transaction types used:

| Type | Documentation | Application |
| --- | --- | --- |
| MPTokenIssuanceCreate | https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate | Set flags 102 (CanLock, RequireAuth, CanTransfer, CanClawback) at creation. AssetScale 0. |
| MPTokenAuthorize | https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize | Holder opts in without Holder field. Issuer approves/revokes with Holder. Revocation flag 1. Holder deletion requires zero balance. |
| MPTokenIssuanceSet | https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset | Lock=1, unlock=2. Holder present means individual; absent means global. |
| Clawback | https://xrpl.org/docs/references/protocol/transactions/types/clawback | MPT Amount has mpt_issuance_id/value; separate Holder field is required. Over-balance amount claws back up to actual balance. |
| Payment | https://xrpl.org/docs/references/protocol/transactions/types/payment | XRP funds new accounts. MPT payments use exact integer amount strings, without partial-payment flags. |

All ledger objects read/relied on:

- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): issuer, capability flags, global lock, outstanding supply, scale.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): MPTAmount, authorization bit 2, lock bit 1; authorization and locking are separate properties.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): funded accounts, sequence, XRP balance, owner reserve. Read indirectly by SDK autofill.
- [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments): validated enabled-amendment IDs, not just supported or majority-voted amendments.

The MPTokenIssuanceSet web renderer returned an error, so the same page's [official Markdown source](https://github.com/XRPLF/xrpl-dev-portal/blob/master/docs/references/protocol/transactions/types/mptokenissuanceset.md) was read directly. Ledger-object and MPT concept Markdown sources were also consulted.

Live network research: https://s.altnet.rippletest.net:51234, network_id=1, rippled 3.4.1. `amendments.json` is the full validated Amendments object at ledger **21144500**. `features.json` maps amendment names to IDs and records server support/enabled status. The validated object confirms MPTokensV1, Clawback, and fixMPTDeliveredAmount enabled. DynamicMPT, ConfidentialTransfer, SingleAssetVault, and BatchV1_1 were disabled. No disabled amendment is used. `demo-amendments.json` repeats the validated check at execution time. All currently enabled IDs are preserved, not only the prerequisites.

Critical compliance semantics:

- [MPT compliance controls](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens#compliance-controls) explicitly permit payments back to the issuer while locked. A native freeze cannot satisfy a literal prohibition on all balance changes. Clawback is also still possible under locks.
- A holder can delete/recreate an empty MPToken object, removing a local lock. Therefore a lock alone is not a ban. Revoked authorization, RequireAuth, and a persistent issuer-side ban tombstone are necessary.
- No AccountSet, trust line, IOU freeze, or account-level AllowTrustLineClawback is needed for these MPT controls.
- Escrow, DEX trading, and confidential balances are disabled for this issuance; this keeps clawback/ban behavior within the supported direct-holder model.
- xrpl 5.3.0 does not re-export MPToken/MPTokenIssuance interfaces at its package root and omits MPToken from its default ledger-entry response union. Explicit type-only imports from the installed package and the typed request response parameter handle that SDK typing gap without `any`.

## Live findings after implementation

The initial negative test for issuer-to-frozen-holder issuance **succeeded**, contradicting the implication in the concept documentation that only redemption is exempt. Hash `6FB5041F784179855AF59DBD6ACCE7F718728E364C7315D75DB2F29F059BF921` proves issuance to individually frozen A. Hash `583428225863067BE0EA5B8BB746CC262748490B60E99C7B9641ED8688D0B1BB` proves issuance during a global freeze. The original operation key `deny:A:issuance` is retained as an honest record of the initial failed assumption; its result is tesSUCCESS. Both probes send one token and are offset by one-token redemption probes. The final demo expects these native exceptions and separately tests backend rejection. The issuer module now rejects new issuance after reading authorization and both lock flags at one validated ledger index. These checks constrain this module, not arbitrary transactions signed by the issuer.

The server also omits MPTAmount when its value is zero, while the SDK declares it required. C's post-clawback validated object at ledger 21144719 has no MPTAmount field. Read boundaries normalize omitted default amounts to `'0'`; this is covered by a regression test.
