# Pre-implementation research

Checked 2026-09-28 (local date), before writing application code or submitting transactions.

## Releases

Live npm registry (`npm view <package> version`):

| Package | Latest stable |
| --- | --- |
| xrpl | 5.3.0 |
| typescript | 7.0.2 |
| tsx | 4.23.15 |
| @types/node | 26.6.3 |

No packages installed yet. Existing runtime: Node 25.9.0, npm 11.12.1.

Read [xrpl.js release history](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md). 5.3.0 adds LendingProtocolV1_1. Relevant preceding changes include seed-prefix algorithm inference, MPT amount typing, DynamicMPT support, and metadata encoding. SDK support does not imply network amendment activation.

## Live testnet check

Queried the public `feature` RPC at https://s.altnet.rippletest.net:51234/. Full response is in `testnet-amendments.json`.

- Enabled: MPTokensV1, Clawback, fixMPTDeliveredAmount, DepositAuth, DepositPreauth, DeepFreeze, TokenEscrow.
- Disabled: DynamicMPT, ConfidentialTransfer, fixCleanup3_4_0, SingleAssetVault, BatchV1_1.
- Configure required MPT capabilities at creation; do not use DynamicMPT fields or capability-setting transactions.
- DeepFreeze relates to trust-line assets, not an additional MPT lock flag.

## Transaction and ledger documentation reviewed

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate)
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize)
- [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset)
- [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback)
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment)
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken)
- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance)
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot)

## Compliance design decision needed

Native MPT locking does not provide the literal no-send/no-receive requirement for issuer interactions. The [MPT overview](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens#compliance-controls) and MPToken reference expressly allow returns to the issuer while locked. Returns burn tokens. Thus an approved, locked B can still reduce its own balance through a return payment.

The upstream [Payment implementation](https://github.com/XRPLF/rippled/blob/develop/src/libxrpl/tx/transactors/payment/Payment.cpp) additionally exempts issuer-to-holder transfers from its direct-MPT lock check. Upstream develop is corroborating design evidence, not proof of the exact deployed server behavior; integration tests must exercise both directions against testnet.

Allowlisting should use RequireAuth and explicit issuer authorization after holder opt-in. Bans should persist issuer policy, revoke authorization, claw back the full balance, and verify validated state. A lock alone is not a durable ban, especially without fixCleanup3_4_0: deleting and recreating a zero-balance holding must not restore approval. No permissioned domain should bypass explicit approval.

Before implementation, choose whether freezes mean native MPT locks with documented issuer exceptions, or require additional account-level redemption restrictions. The latter changes the issuer account's deposit behavior and requires further design and documentation research. No account changes or token creation have been performed; result.json cannot truthfully be produced yet.
