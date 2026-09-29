# Research completed before implementation

Checked on 2026-09-29 (UTC). `npm view xrpl version dist-tags repository.url` returned stable latest **5.3.0**. Experimental dist-tags were not selected. npm also reported TypeScript **7.0.2**, tsx **4.23.15** and the installation resolved latest @types/node **26.6.3**. No additional runtime packages were installed.

Read the [SDK release history](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md), saved as `xrpl-HISTORY.md`. Release 5.3.0 adds LendingProtocolV1_1; 5.2 changes entropy validation; 5.1 adds newer MPT features that are not necessarily enabled on testnet; 5.0 changes seed algorithm inference and MPT amount typing. We use `Wallet.fromSeed` with the supplied sEd seed, `Wallet.generate`, typed transactions, `autofill`, local signing and `submitAndWait`. No experimental MPT fields are used.

## Transaction references read

* [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): flags 2+4+32+64, integer amounts, scale zero, bounded maximum.
* [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): holder opt-in versus issuer approval/revocation; Holder field distinguishes the issuer action; tfMPTUnauthorize is 1.
* [MPTokenIssuanceSet](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuanceset): lock flag 1, unlock flag 2; Holder scopes the lock, omission applies globally.
* [Clawback](https://xrpl.org/docs/references/protocol/transactions/types/clawback): MPT clawback uses Holder and Amount.mpt_issuance_id; amounts exceeding the balance drain it.
* [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): XRP funding and direct MPT transfers. Amount and DeliverMax are aliases; supply only one. No partial-payment flag.
* [AccountSet](https://xrpl.org/docs/references/protocol/transactions/types/accountset): asfDepositAuth=9 closes the redemption exception for this dedicated issuer.

## Ledger object references read

* [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): issuance identity, capabilities, outstanding supply, lock state.
* [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): holder balance, Authorized=2, Locked=1, and the issuer-return lock exception.
* [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): funding, account flags, DepositAuth=0x01000000.
* [DepositPreauth](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/depositpreauth): address and credential preauthorizations could bypass DepositAuth; require none.
* [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments): authoritative enabled IDs at the singleton key.

Also read the [MPT overview](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens) and [freeze semantics](https://xrpl.org/docs/concepts/tokens/fungible-tokens/freezes).

## Live testnet amendment check

Endpoint: `https://s.altnet.rippletest.net:51234/` / `wss://s.altnet.rippletest.net:51233`.

`features.json` stores the live feature response with names and status for all reported amendments. `amendments.json` stores the **validated** Amendments ledger entry, independently confirming active hashes. `run-network.json` records server version, network ID, and the validated amendments checked by the demo at runtime. The complete enabled set is in those snapshots; the relevant selection is:

| Amendment | Enabled | Relevance |
|---|---|---|
| MPTokensV1 | Yes | Required for issuance, authorization, locks, MPT payments/clawback |
| Clawback | Yes | Required for Clawback transactions |
| DepositAuth | Yes | Blocks unsolicited issuer redemptions |
| fixMPTDeliveredAmount | Yes | MPT payment metadata fix |
| TokenEscrow | Yes | Deliberately not enabled for this issuance |
| DynamicMPT | No | No mutable-property/ImmutableFlags fields used |
| ConfidentialTransfer | No | No confidential balances used |
| SingleAssetVault | No | No vault/domain integration used |
| fixCleanup3_4_0 | No | Cannot rely on locked zero-balance entries resisting deletion |

The ban therefore uses authorization revocation and durable issuer policy, not merely a lock. Native locks allow redemption; DepositAuth supplements them. The demo directly checks both protocol edge cases.

## Findings while validating on testnet

The installed SDK's `LedgerEntry` union omits MPToken even though the namespace contains its type. The RPC boundary explicitly validates holder fields. Also, rippled omits `MPTAmount` when zero even though documentation marks it required; the module normalizes this omission to `"0"`. The first demo interruption exposed this mismatch before approval; the journal resumed the same issuance without duplication.

The completed run recorded 38 validated transactions: 29 successful and 9 deliberately rejected. Native locks returned `tecLOCKED` in both holder-transfer directions; DepositAuth returned `tecNO_PERMISSION` for frozen redemptions. C's empty entry deletion and recreation both succeeded, but subsequent receipt returned `tecNO_AUTH`. The final snapshot at ledger 21135587 has A=500 (authorized, unlocked), B=700 (authorized, locked), C=0 (unauthorized), issuance flags=102 (globally unlocked), and outstanding supply=1200. An independent read-only verification at ledger 21135592 confirmed the same state.
