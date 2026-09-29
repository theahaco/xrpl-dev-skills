# Research completed before project implementation

Checked on 2026-09-29. The npm registry (`npm view xrpl version dist-tags --json`)
reported **5.3.0** as the latest stable release. Search-engine npm results were
stale, so the registry was used. Other installed direct packages were checked
with `npm view <package> version`: **typescript 7.0.2**, **@types/node 26.6.3**.
Versions are pinned in package.json and the complete dependency tree is locked.
The existing Node.js and npm installation was used; no runtime or package
manager was installed.

Read the [xrpl release history](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md),
saved as `xrpl-HISTORY.md`. Version 5.3.0 adds LendingProtocolV1_1; 5.2.0 tightens
Wallet.fromEntropy validation; 5.1.0 adds Dynamic MPT support; 5.0.0 changes
Wallet.fromSeed algorithm inference and corrects MPTAmount to a string.
This project uses Wallet.fromSeed, Wallet.generate, Client.autofill,
Wallet.sign, Client.submitAndWait and Client.request, with the installed types.
The 5.3.0 general LedgerEntry union omits MPToken, so the holder response is
validated at runtime from unknown rather than trusting a cast.

Transaction documentation read:

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate):
  require authorization flag 4; transferable flag 32; AssetScale 0 means whole units.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize):
  holder opts in without Holder; issuer grants approval with Holder set.
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment):
  XRP funding and direct MPT payment; MPT amount uses mpt_issuance_id and value.
  Amount is accepted as the DeliverMax alias; only Amount is sent, with no partial-payment flag.

Ledger object documentation read:

- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance):
  OutstandingAmount measures circulation; lsfMPTRequireAuth is 4.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken):
  MPTAmount is the holder balance; lsfMPTAuthorized is 2.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot):
  accounts are created by a sufficient XRP Payment.
- [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments/):
  Amendments lists active amendment IDs in that ledger.

Also read [ledger_entry](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry)
for mpt_issuance and mptoken lookup parameters and the
[known amendments reference](https://xrpl.org/resources/known-amendments).

## Actual testnet amendment check

Queried https://s.altnet.rippletest.net:51234/ with `feature` and `ledger_entry`
for the validated Amendments entry, before writing project code. Complete
responses are in `testnet-features.json` and `testnet-amendments.json`.
The latter is validated ledger **21134436**. The feature response maps names to
IDs; membership in the validated ledger confirms activation.

| Amendment | Enabled |
| --- | --- |
| MPTokensV1 | yes |
| fixMPTDeliveredAmount | yes |
| DynamicMPT | no |
| ConfidentialTransfer | no |
| fixCleanup3_4_0 | no |

The implementation uses basic MPT issuance, explicit issuer approval and direct
payments. It does not rely on domains, immutable flags, confidential balances,
DEX trading or other optional amendment features. It checks both required
amendments again before executing and saves `runtime-amendments.json`.
