# Research completed before implementation

Checked 2026-09-29 against the npm registry, XRPL documentation, and the live testnet RPC at `https://s.altnet.rippletest.net:51234`.

## SDK and tools

`npm view xrpl version dist-tags --json` returned **5.3.0** as `latest`; experimental tags were excluded. The [5.3.0 release changelog](https://github.com/XRPLF/xrpl.js/releases/tag/xrpl%405.3.0), published September 16, adds Lending Protocol V1_1 support. Its [full change comparison](https://github.com/XRPLF/xrpl.js/compare/xrpl%405.2.0...xrpl%405.3.0) is linked there. We use the installed SDK's MPT transaction definitions, enum values, local signing, `autofill`, and `submitAndWait`. Its ledger-entry union omits MPToken despite exporting that interface through the LedgerEntry namespace; the read helper explicitly includes that type.

Latest direct npm versions queried and installed exactly: xrpl 5.3.0, TypeScript 7.0.2, tsx 4.23.15, @types/node 26.6.3. `package-lock.json` pins the resolved dependency graph. The existing runtime is Node 25.9.0; SQLite, cryptography, and tests use Node built-ins. No frontend scaffold is needed for this backend module.

## Transaction references read

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): capabilities enabled at creation; integer base units; explicit maximum and asset scale. Flags total 102: lock, authorization, transfer, clawback. Escrow, DEX trading and confidential balances remain disabled.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): holder opt-in and issuer approval are separate. Issuer revocation uses Holder plus tfMPTUnauthorize.
- [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset): lock/unlock use flags 1/2, with Holder for an individual and without Holder for global scope. The page was also read from its [official documentation source](https://raw.githubusercontent.com/XRPLF/xrpl-dev-portal/master/docs/references/protocol/transactions/types/mptokenissuanceset.md) when browser retrieval failed.
- [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback): MPT Amount contains mpt_issuance_id and value; Holder is a separate required field. A request greater than balance drains the available balance. Zero is invalid.
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): XRP funding and direct MPT transfers. The SDK accepts Amount; no partial payment flags or paths are used.
- [AccountSet](https://xrpl.org/docs/references/protocol/transactions/types/accountset): asfDepositAuth=9 closes the redemption exception at the issuer account.

## Ledger objects read

- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): issuer, supply, capability flags and global lock.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): holder balance, lock=1 and authorization=2. **Locks alone allow sending back to the issuer.**
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): account balance, owner count, sequence, DepositAuth state.
- [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments): enabled amendment IDs from a validated ledger, rather than relying on a server's support/voting status.
- [DepositPreauth](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/depositpreauth): account or credential preauthorization would bypass the issuer's DepositAuth protection. The profile rejects either kind, with pagination.

Also read [Deposit Authorization](https://xrpl.org/docs/concepts/accounts/depositauth) and [MPT concepts](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens). DepositAuth is account-wide: this design rejects unsolicited redemption payments even when unlocked. It does not prevent issuer-initiated clawback. Maintaining this dedicated issuer profile is required for the stronger freeze guarantee.

Implementation-time empirical finding: the validated `frozen-A-issuer-send` probe succeeded despite the holder lock. Native locks also exempt issuer-originated payments. The backend must refuse minting when either lock is set; this is an issuer signing policy, not protocol enforcement against the issuer. The demo retains the proof and claws back the one-token probe. The requested strong semantics depend on the backend being the sole issuer signer.

The live response also omits zero MPTAmount fields, although the SDK interface marks them required. Holder reads normalize the omitted default to zero; the standalone verifier checks that convention independently. Minimal demo metadata is ledger-valid but does not supply full XLS-89 branding (icon and issuer display name); the SDK emits an advisory warning at creation. It does not affect balances or compliance controls.

## Testnet evidence

The live endpoint reported network_id=1, rippled 3.4.1, reserve base=1 XRP and owner increment=0.2 XRP. The initial validated amendment check was at ledger 21134308; the saved snapshots and demo preflight provide the subsequent exact ledger data. `evidence/features-before.json` contains the full named feature list; `evidence/amendments-before.json` contains the validated on-ledger IDs.

Enabled and required: **MPTokensV1, Clawback, DepositAuth, fixMPTDeliveredAmount**. The runtime checks both enabled status and membership in the validated Amendments object. Other enabled features include DepositPreauth, TokenEscrow, PermissionedDomains and PermissionedDEX; the issuance does not enable their token capabilities.

**DynamicMPT, ConfidentialTransfer, SingleAssetVault and fixCleanup3_4_0 are disabled.** No corresponding new fields or behaviors are assumed. In particular, on this testnet an empty locked holding can be deleted; the demo deletes and recreates C's holding and verifies issuer approval does not return. The durable ban policy prevents accidental backend reapproval. The capability flags are set at creation without DynamicMPT fields.
