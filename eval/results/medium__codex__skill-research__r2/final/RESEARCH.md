# Research completed before implementation

Checked 2026-09-29 against npm, the xrpl.js release history, xrpl.org, and the live XRPL Testnet.

## Package versions

`npm view xrpl version dist-tags --json` returned **5.3.0** as `latest` (published September 16, 2026). The npm web search cache showed 5.2.0, so the live registry was used. Installed exact versions: xrpl 5.3.0, TypeScript 7.0.2, @types/node 26.6.3, all the current npm `latest` tags at installation. Dependencies are locked in package-lock.json. Existing Node v25.9.0 and npm 11.12.1 were used; no additional runtime or scaffolding tools were installed.

Read the [official xrpl.js release history](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/HISTORY.md). Version 5.3.0 adds LendingProtocolV1_1. Relevant preceding changes: 5.2.0 tightens Wallet.fromEntropy; 5.1.0 adds Dynamic MPT and confidential-transfer types; 5.0.0 infers the signing algorithm from seed prefixes and corrects MPTAmount to string. This project uses Wallet.fromSeed, Wallet.generate, Client.autofill, local signing, and Client.submitAndWait. MPT values remain decimal strings.

## Transaction references read

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): AssetScale 0 means whole tokens; tfMPTRequireAuth is 4. Only this capability is requested. Holder-to-holder transfers are disabled; issuance directly from the issuer is supported.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): the holder opts in without Holder; the issuer approves with Holder set to the holder address. No unauthorize flag.
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): XRP payment activates the holder account. MPT payment uses Amount with mpt_issuance_id and value. Amount is accepted for signing; API v2 responses use DeliverMax. Partial payments are not enabled.

## Ledger-object references read

- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): OutstandingAmount is the circulating supply. Issuance ID is 192 bits, distinct from the 256-bit ledger entry index. This project obtains the issuance ID from validated creation metadata.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): MPTAmount is the holder balance; lsfMPTAuthorized is 2.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): Balance, OwnerCount and Sequence underpin funding/reserve checks and SDK autofill.
- [Amendments](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amendments): the singleton's Amendments array lists enabled amendment IDs.
- [FeeSettings](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/feesettings): reserves and base transaction cost. The script reads the current reserves through server_info's validated_ledger summary.

Also read [ledger_entry](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry) for mpt_issuance and mptoken selectors. Both final queries are pinned to the same validated ledger hash.

## Testnet verification

Endpoint: wss://s.altnet.rippletest.net:51233 (HTTP research queries used https://s.altnet.rippletest.net:51234). server_info reported network_id 1, rippled 3.4.1, base reserve 1 XRP and owner reserve 0.2 XRP.

The complete live feature response is in research/testnet-features.json. The validated Amendments object is in research/testnet-amendments.json (ledger 21144834). Both confirmed:

| Amendment | Enabled |
| --- | --- |
| MPTokensV1 | Yes |
| fixMPTDeliveredAmount | Yes |
| DynamicMPT | No |
| ConfidentialTransfer | No |

MPTokensV1 ID: 950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38.

The implemented flow relies on MPTokensV1 and ordinary XRP payments. It does not use newer optional MPT capabilities. The executable checks the validated amendment object again before submitting transactions; receipts/preflight.json preserves that check.
