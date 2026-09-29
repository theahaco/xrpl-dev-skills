# Research performed before implementation — 2026-09-29 UTC

Queried the live npm registry with `npm view`: latest stable `xrpl` is **5.3.0**, TypeScript **7.0.2**, and `@types/node` **26.6.3**. These direct dependencies are pinned exactly, and package-lock.json fixes the dependency tree. Existing Node v25.9.0 and npm 11.12.1 were used; no additional runtime or package manager was installed.

Read the live [xrpl changelog](https://raw.githubusercontent.com/XRPLF/xrpl.js/main/packages/xrpl/HISTORY.md) using curl because the search cache was behind. Version 5.3.0 (September 16) adds LendingProtocolV1_1 support. Version 5.2.0 tightens Wallet.fromEntropy input and supports updated signing prefixes. The 5.0 changes include seed-prefix algorithm inference and the correction of MPTAmount to a string. The project uses Wallet.fromSeed, Wallet.generate, Client.autofill, local signing, submitAndWait, and ledger_entry; no lending or experimental features are needed.

Read the xrpl.org documentation for all transaction types used:

- [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate): requires MPTokensV1; tfMPTRequireAuth is 4. Set AssetScale to 0 so 1,000 ledger units represent 1,000 tokens.
- [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize): the holder opts in with no Holder field; the issuer grants permission using Holder. Both steps precede payment.
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment): funds the new account with XRP and issues MPT using an amount object. No partial-payment flag is used. The SDK accepts Amount for signed transactions.

Read the ledger objects used:

- [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance): OutstandingAmount is circulating supply; lsfMPTRequireAuth enforces issuer approval.
- [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken): MPTAmount is the holder balance; lsfMPTAuthorized is 2.
- [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot): account balance, sequence, and owner count support funding and transaction preparation.
- [ledger_entry](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry): mpt_issuance takes the 192-bit issuance ID; mptoken takes account and mpt_issuance_id.

Queried `server_info` and `feature` directly on `https://s.altnet.rippletest.net:51234/` before coding. Server version was 3.4.1, network ID 1. MPTokensV1 (`950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38`) and fixMPTDeliveredAmount were enabled. DynamicMPT, ConfidentialTransfer, SingleAssetVault, and fixCleanup3_4_0 were disabled. The project relies on base MPT authorization and payments only, without fields or behaviors gated by these disabled amendments. Base XRP reserve was 1 XRP and incremental owner reserve 0.2 XRP; 5 XRP funds the holder's reserve and fees.

The program repeats the network and MPTokensV1 checks before any transaction and saves the full named amendment snapshot in amendments.json.

Implementation observation: xrpl 5.3.0's LedgerEntry union omits MPToken, so the holder response is checked as unknown with explicit runtime field validation, preserving strict TypeScript checking.
