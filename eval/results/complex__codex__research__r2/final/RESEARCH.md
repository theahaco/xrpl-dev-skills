# Research before implementation — 2026-09-29

The npm registry `latest` tag resolves to **xrpl 5.3.0**, published 2026-09-16.
Source: [npm registry](https://registry.npmjs.org/xrpl/latest).
The [version-tagged changelog](https://github.com/XRPLF/xrpl.js/blob/xrpl%405.3.0/packages/xrpl/HISTORY.md) was read before implementation; the cached web copy of `main` was stale (5.1.0), so the release tag was used. Version 5.3.0 adds LendingProtocolV1_1 support; 5.2.0 tightens entropy inputs; 5.0.0 infers signing algorithms from seed prefixes. The implementation uses `Wallet.fromSeed`, `Wallet.generate`, `autofill`, local signing, and `submitAndWait`, followed by validated metadata checks.

Other installed packages were resolved through npm's current `latest` tag: TypeScript 7.0.2, tsx 4.23.15, @types/node 26.6.3. All direct versions are exact, and transitive resolution is committed in package-lock.json. The existing Node v25.9.0 and npm 11.12.1 were used; no runtime was installed. `npm audit` reported zero vulnerabilities after installation.

## Transaction documentation read

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): create flags 2 + 4 + 32 + 64 = 102; scale 0 means integer token units. Escrow, trade, and confidential balances are not enabled.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): holder opts in first; issuer separately approves with `Holder`. Issuer revokes with `tfMPTUnauthorize`.
- [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset): lock/unlock flags 1/2; omit `Holder` for global scope.
- [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback): MPT amount uses `mpt_issuance_id` and `value`, with the holder in the separate `Holder` field. A request above the holder's balance removes the full balance; zero is invalid.
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): XRP funding and direct MPT transfers. The SDK accepts `Amount` for signing; API v2 returns `DeliverMax`. No partial payments, paths, or SendMax are used.

## Ledger object documentation read

- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): issuer, capability flags, scale, outstanding supply, and issuance identity.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): balance and holder lock/authorization bits.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): XRP funding creates holder accounts; autofill obtains sequence information.
- [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments): enabled amendment IDs in validated state.

Markdown copies fetched directly from each xrpl.org page's `.md` endpoint are in `research/`.

## Actual testnet support

Queried `feature` at `https://s.altnet.rippletest.net:51234/` before coding; the complete response is `research/testnet-features.json`. Also saved the validated Amendments object in `research/testnet-amendments-ledger.json`. The demo repeats the feature check, verifies network ID 1, and refuses to sign if required amendments are disabled.

| Amendment | Enabled |
| --- | --- |
| MPTokensV1 | Yes |
| Clawback | Yes |
| fixMPTDeliveredAmount | Yes |
| TokenEscrow | Yes, but not enabled for this issuance |
| DynamicMPT | No |
| ConfidentialTransfer | No |
| SingleAssetVault | No |
| fixCleanup3_4_0 | No |

No dynamic capability changes, ImmutableFlags, domains, confidentiality, or future holder-deletion restrictions are assumed.

## Material semantics

[The MPT overview](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens) and MPToken reference explicitly document a return-to-issuer exception to locking. Native locks are therefore not an absolute stop on all balance changes. The integration run additionally demonstrated that an issuer payment to a locked holder succeeds on this testnet (see `deny:A:issue` in transactions.json). That token was clawed back by `probe:A:compensate`. The module now checks holder and issuance locks before issuing; that backend check cannot constrain other issuer signers. The module exposes native MPT locks and documents this limitation; it does not claim the stricter compliance guarantee in the original request. Clawback is an administrative exception as well.

Bans combine durable local refusal to reapprove with ledger authorization revocation and clawback. A holder deleting/recreating its holding does not regain issuer approval. This issuance disallows escrow and other extended holding modes so balance cannot be moved into those mechanisms before a ban.

SDK 5.3.0 exports ledger types through the `LedgerEntry` namespace and omits MPToken from its general LedgerEntry union. The holder reader applies a localized runtime check before narrowing to `LedgerEntry.MPToken`.

The live zero-balance MPToken response omitted `MPTAmount` after clawback, despite the SDK declaring it required. The reader normalizes this protocol default to `"0"` and rejects malformed explicit values. A regression test covers this case.
