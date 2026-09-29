# Research completed before implementation

Checked September 28, 2026 New York / September 29 UTC. Live RPC and npm registry results take precedence over search-index snippets and stale skill examples.

## Packages

`npm view xrpl version` returned **5.3.0**, published September 16, 2026. [Official changelog](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md) was read before implementation; its snapshot is [research/xrpl-HISTORY.md](research/xrpl-HISTORY.md), with registry evidence in [research/xrpl-npm.json](research/xrpl-npm.json). The release adds lending protocol support. Relevant preceding changes include MPT API support, the corrected string `MPTAmount` type, seed-algorithm inference, and DynamicMPT types. SDK availability does not mean a feature is enabled on testnet.

Latest npm versions queried and installed: `xrpl` 5.3.0, TypeScript 7.0.2, `tsx` 4.23.15, `@types/node` 26.6.3. No framework or frontend dependencies are needed for this backend module. npm resolved transitive dependencies under the newest SDK's constraints; package-lock.json records the complete dependency graph. No new Node runtime was installed; the supplied runtime is 25.9.0.

Installed SDK source/types were checked too. In 5.3.0, MPT ledger interfaces are not exposed by the package root and MPToken is omitted from the default response union; the module uses explicit SDK type-only imports and generic typed ledger responses with runtime entry-type checks. Metadata uses `encodeMPTokenMetadata` with long-form input field names. Signing uses the SDK's `Amount` field; API v2 responses can call this `DeliverMax`.

## Transaction documentation read

| Official reference | Decision |
| --- | --- |
| [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate) | Set CanLock, RequireAuth, CanTransfer, CanClawback at creation; no DynamicMPT fields. Explicit scale, supply cap and zero fee. |
| [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize) | Holder opts in without Holder field; issuer grants/revokes with Holder. Test zero-balance deletion/recreation after revocation. New cleanup behavior mentioned in docs is amendment-gated. |
| [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset) | Lock/unlock flags 1/2, optional Holder selects individual versus global scope. |
| [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback) | MPT amount uses issuance ID and integer value, with separate Holder field. Larger-than-balance clawback drains the balance; zero amount is invalid. |
| [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment) | Fund accounts with XRP and distribute/transfer/redeem MPTs. No partial-payment flag, paths or currency conversion. |

## Ledger-object documentation read

| Official reference | Decision |
| --- | --- |
| [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance) | Verify issuer, capabilities, global lock, scale and outstanding supply at a validated ledger. Obtain the 192-bit issuance ID from creation metadata. |
| [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken) | Read integer MPTAmount and holder flags: locked=1, authorized=2. Documentation explicitly preserves redemption to issuer while locked. |
| [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot) | Read XRP balance and owner count for funding/reserve preflight. Account settings are unchanged. |

Also read [MPT concepts](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens), [feature RPC](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/feature), and [ledger_entry RPC](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry). Only AccountRoot, MPTokenIssuance and MPToken ledger objects are consumed by this implementation; feature RPC supplies amendment status without reading the Amendments object.

## Live testnet confirmation

During live validation, zero balances were observed with `MPTAmount` omitted entirely. The reader normalizes this protocol default to the string `"0"` despite the SDK's required-field declaration. A regression test covers this case; transport failures are never treated as zero balance.

Pre-code `feature` and `server_info` calls to `https://s.altnet.rippletest.net:51234/` are saved in [testnet-features.json](research/testnet-features.json) and [testnet-server-info.json](research/testnet-server-info.json). The node reports rippled 3.4.1, network ID 1, base reserve 1 XRP, owner reserve 0.2 XRP. The complete feature map contains all amendments the node knows, including enabled status and IDs.

| Amendment | Enabled | Dependency |
| --- | --- | --- |
| MPTokensV1 | Yes | Required for MPT transactions and ledger entries |
| Clawback | Yes | Checked for clawback support |
| fixMPTDeliveredAmount | Yes | Checked for corrected MPT payment reporting |
| TokenEscrow | Yes | Not used; escrow capability excluded |
| DynamicMPT | No | Not used; all capabilities selected initially |
| ConfidentialTransfer | No | Not used |
| fixCleanup3_4_0 | No | Do not assume newer locked-holding deletion restrictions |

Every new submission rechecks network ID, validated-ledger freshness and required amendments. The demo saves another full preflight snapshot. Per-holder and global redemption exceptions are exercised on the live network; native locks cannot meet an absolute freeze requirement. Live probing additionally showed issuer-originated payments bypass the holder lock; the demo records issuer-interaction probes and reverses their test amounts. `issue()` enforces a stricter local rule, which an external issuer-key user can bypass. A service-level ban additionally needs a durable policy tombstone, because an issuer holding the signing key could otherwise reauthorize a revoked holder.
