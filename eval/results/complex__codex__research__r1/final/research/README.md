# Research before implementation

Checked 2026-09-28 America/New_York (2026-09-29 UTC). No application code was written until package/changelog, transaction/object documentation and live amendment checks were completed.

## Packages

The npm registry (`npm view ... version`) reported these latest stable versions, which were then installed exactly and captured in package-lock.json:

| Package | Version |
| --- | --- |
| xrpl | 5.3.0 |
| typescript | 7.0.2 |
| tsx | 4.23.15 |
| @types/node | 26.6.3 |

The npm web search cache showed an older version, so the live npm registry was authoritative. Existing Node 25.9.0 and npm 11.12.1 were used; no runtime or other tooling was installed.

Read the upstream [xrpl release history](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md), including 5.3.0 (2026-09-16), 5.2.0, 5.1.0 and 5.0.0 migration notes. 5.3.0 adds LendingProtocolV1_1 support. Relevant earlier changes include seed-prefix algorithm inference, Dynamic MPT types, and changed server-info error handling. The implementation explicitly verifies network ID instead of assuming connection success proves the network. Current signing, amount and ledger-entry APIs were also checked against installed declarations.

## Transaction documentation read

| xrpl.org reference | Applied decision |
| --- | --- |
| [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate) | Set CanLock (2), RequireAuth (4), CanTransfer (32), CanClawback (64) at creation: flags 102. Use integer supply, scale zero. Omit DynamicMPT fields. |
| [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize) | Separate holder enrollment from issuer authorization. Use issuer Holder and tfMPTUnauthorize=1 for revocation. Enrollment alone is not authorization. |
| [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset) | Lock=1, unlock=2; Holder selects an individual object, omission selects the issuance. The page's global example and rippled implementation clarify the overly restrictive wording in its flag table. |
| [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback) | MPT clawback requires Holder and an MPT Amount, not a trust-line issuer field or the old proposal's MPTokenHolder. Positive amount only; excess is capped at balance. |
| [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment) | XRP payments fund accounts. MPT amounts use mpt_issuance_id and integer value strings. No partial-payment flag. Amount remains a supported input alias for DeliverMax. |

## Ledger-object documentation read

| xrpl.org reference | Applied decision |
| --- | --- |
| [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance) | Verify issuer, capability flags, global lock, scale, transfer fee and outstanding supply. |
| [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken) | Read balance, lock bit 1 and authorization bit 2. Native locks explicitly retain redemption to the issuer. |
| [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot) | Accounts are funded using XRP Payment; SDK autofill uses account sequence. No account-wide IOU flags are needed for MPT controls. |
| [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments) | Verify enabled IDs from the validated singleton entry, not merely server support or voting majority. |

Also consulted [MPT concepts](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens), [ledger_entry](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry), and upstream rippled MPTokenIssuanceSet/Clawback implementations to check global-lock selection and clawback bypass of authorization/freezes.

## Live testnet evidence

Endpoint: https://s.altnet.rippletest.net:51234/ (read-only research), wss://s.altnet.rippletest.net:51233 (application). Server reported network ID **1**, rippled **3.4.1**. See [server-info.json](server-info.json), [features.json](features.json) and [amendments.json](amendments.json). Initial validated amendment ledger: **21133965**; the JSON preserves its hash and full enabled-ID list. features.json supplies the name/ID mapping and both enabled/disabled states.

| Amendment | Enabled in validated ledger |
| --- | --- |
| MPTokensV1 | Yes |
| Clawback | Yes |
| fixMPTDeliveredAmount | Yes |
| DynamicMPT | No |
| ConfidentialTransfer | No |
| BatchV1_1 | No |
| fixCleanup3_4_0 | No |

The implementation uses MPTokensV1 and Clawback and rechecks both before signing. It does not rely on dynamic capabilities, batch atomicity, confidentiality, trading, escrow or permissioned domains. Features merely supported by the server are not treated as enabled.

## Findings from integration

The installed SDK's generic LedgerEntry union omits MPToken even though the dedicated type exists. A narrow adapter checks the actual ledger type, holder account, issuance ID, flags and amount at runtime. rippled omits zero-valued MPTAmount; reads normalize that default to "0". Serialized MPT Amount object fields may have a different key order; signing integrity checks compare structures, not JSON property order.

The demo records actual validated outcomes in ../demo-evidence.json, including successful payments involving the issuer **in both directions** under individual/global locks. The initially negative probe keyed `issuer-cannot-send-to-frozen-A` unexpectedly succeeded on testnet; its original key and actual receipt were retained for exactly-once recovery. This goes beyond the documentation's stated redemption exception. The module blocks issuer issuance while frozen, but cannot prevent holder-initiated redemption. These exceptions are material differences from the requested absolute-freeze semantics, documented in the public API and README.
