# Research completed before implementation

Checked 2026-09-28 America/New_York (2026-09-29 UTC).

## Packages and SDK APIs

`npm view <package> version` returned xrpl **5.3.0**, TypeScript **7.0.2**, tsx **4.23.15**, and @types/node **26.6.3**. All direct dependencies are pinned exactly; package-lock.json pins the dependency tree. Existing Node 25.9.0 and npm 11.12.1 were used, not installed by this task.

Read the [xrpl changelog](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md) and [5.3.0 release](https://github.com/XRPLF/xrpl.js/releases/tag/xrpl%405.3.0). A snapshot is in evidence/xrpl-HISTORY.md. 5.3.0 adds LendingProtocolV1_1 support; 5.1 adds Dynamic MPT and confidential-transfer types, which do **not** imply testnet availability. 5.0 infers signing algorithm from the seed and corrects the MPTAmount type to string. The implementation uses local signing, autofill, submitAndWait, and validated transaction metadata. Amounts are integer strings, never floating point.

The installed package's root export/ledger union omits MPToken. The implementation imports its shipped type from the package subpath and specializes the ledger_entry response. No SDK fork or older SDK is used.

## Transaction references read

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): flags CanLock (2), RequireAuth (4), CanTransfer (32), CanClawback (64); combined **102**. Scale zero makes 500 ledger units equal 500 demo tokens. No trade, escrow, confidential balance or domain authorization.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): holder opt-in and issuer approval are distinct. Issuer uses Holder; holder omits it. Issuer unauthorization is reversible on-ledger; the backend ban policy prevents reapproval.
- [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset): lock=1, unlock=2; Holder selects one account, omission selects the issuance.
- [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback): MPT amount includes mpt_issuance_id; Holder is required. Amounts exceeding the balance claw back the available balance. No trust-line AccountSet flags apply.
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): direct XRP funding and MPT payments; no partial-payment flag, paths or exchange. Payment amounts in the module use the SDK-supported Amount field.

Read the [MPT concepts and compliance controls](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens). **Locks allow return payments to the issuer.** Neither per-holder nor global locking is an absolute stop on token movement. Clawback remains available during locking. Application prechecks cannot prevent holders submitting redemption transactions directly. The demo records successful redemptions while locked and restores A's balance.

## Ledger object references read

- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): issuer, capability flags, global lock, scale, outstanding amount, issuance ID.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): MPTAmount string; locked=1, authorized=2. Authorization is lost when a zero-balance holding is deleted and recreated.
- [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments): enabled IDs in the singleton validated ledger object.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): account balance, owner count, sequence; read through account_info.
- [FeeSettings](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/feesettings): current reserve fields; operational reserve values are read from server_info.

Also checked the official [MPTokenAuthorize implementation](https://github.com/XRPLF/rippled/blob/release/3.4.x/src/libxrpl/tx/transactors/token/MPTokenAuthorize.cpp) for issuer revocation and holder deletion rules.

## Actual testnet capability checks

Queried `feature` and `server_info` directly on https://s.altnet.rippletest.net:51234 before writing code. Network ID **1**, rippled **3.4.1**, reserve base **1 XRP**, reserve increment **0.2 XRP**. The demo repeats the checks over wss://s.altnet.rippletest.net:51233 and confirms required amendment IDs in the validated Amendments object.

| Amendment | Enabled in observed testnet |
|---|---|
| MPTokensV1 | Yes |
| Clawback | Yes |
| fixMPTDeliveredAmount | Yes |
| TokenEscrow | Yes (not used) |
| DynamicMPT | No |
| ConfidentialTransfer | No |
| SingleAssetVault | No |
| fixCleanup3_4_0 | No |

Full feature response: evidence/features.json. Runtime server and amendment evidence: evidence/preflight.json. No use of unsupported mutable flags, immutable flags, confidential features, vaults, or domain-based authorization. Recheck before every deployment because testnet can reset and amendment availability changes.

## Live-test correction to the documentation

The live per-holder freeze test showed that an issuer-to-holder Payment succeeds while the holder is locked. The official [Payment implementation](https://github.com/XRPLF/rippled/blob/release/3.4.x/src/libxrpl/tx/transactors/payment/Payment.cpp#L698-L710) explicitly excludes both issuance and redemption from the lock check: it checks locks only when neither endpoint is the issuer. This is broader than the MPT concepts page's redemption-only description. The demo records both exceptions and compensates each test issuance with a clawback. Backend `issue()` adds a stricter application-level guard, which cannot constrain other users of the issuer signing key.

A second live discrepancy: the server omits `MPTAmount` on a zero-balance holding, while the SDK type and documentation mark it required. The [ledger schema](https://github.com/XRPLF/rippled/blob/release/3.4.x/include/xrpl/protocol/detail/ledger_entries.macro#L417-L420) declares this field `SoeDefault`; omission means zero. The reader normalizes it to `'0'`, and the independent verifier accepts that default only on an existing holding. A regression test covers it.
