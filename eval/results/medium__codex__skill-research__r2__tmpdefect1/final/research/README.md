# Research before implementation — 2026-09-29 UTC

Queried npm directly (`npm view <package> version`) before installing. Latest stable versions: xrpl **5.3.0**, TypeScript **7.0.2**, @types/node **26.6.3**. All direct dependencies are pinned and the complete resolved tree is locked in package-lock.json. Existing Node 25.9.0 and npm 11.12.1 were used; no runtime or extra CLI was installed.

Read the [xrpl 5.3.0 release changelog](https://github.com/XRPLF/xrpl.js/releases/tag/xrpl%405.3.0), published September 16, 2026: adds Lending Protocol V1_1 support. The release and full changelog link are archived in `xrpl-release.json`; registry version evidence is in `npm-xrpl.json`. Search-engine npm results were stale (5.2.0), so the registry was authoritative. Inspected installed SDK declarations for current signing, submission, metadata, and ledger query APIs. Its public ledger union omits MPToken; the project imports that type from the pinned SDK's declaration file and checks the returned entry type at runtime.

Read these xrpl.org pages before writing project code:

| Kind | Documentation | Use |
| --- | --- | --- |
| Transaction | [MPTokenIssuanceCreate](https://xrpl.org/docs/references/protocol/transactions/types/mptokenissuancecreate) | AssetScale 0, tfMPTRequireAuth=4, no amendment-dependent optional extensions |
| Transaction | [MPTokenAuthorize](https://xrpl.org/docs/references/protocol/transactions/types/mptokenauthorize) | Holder opt-in without Holder; issuer approval with Holder |
| Transaction | [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment) | XRP funding and exact MPT issuance; no partial payments |
| Ledger entry | [MPTokenIssuance](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance) | RequireAuth flag and OutstandingAmount |
| Ledger entry | [MPToken](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken) | Authorized flag=2 and MPTAmount |
| Ledger entry | [AccountRoot](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot) | Issuer Balance and OwnerCount reserve check |
| API | [ledger_entry](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry) | mpt_issuance and mptoken selectors |

Queried the actual testnet `feature` and `server_info` APIs before implementation at https://s.altnet.rippletest.net:51234. Initial server snapshot: network ID 1, rippled 3.4.1, validated ledger 21134513, base reserve 1 XRP and owner reserve 0.2 XRP. The full feature map is archived in `testnet-features.json` and refreshed immediately before execution, together with `server-info.json`.

MPTokensV1 (950AE2EA4654E47F04AA8739C0B214E242097E802FD372D24047A89AB1F5EC38) and fixMPTDeliveredAmount are enabled. DynamicMPT, ConfidentialTransfer and SingleAssetVault are disabled; the project uses none of their fields. PermissionedDomains and TokenEscrow are enabled but unnecessary here. Basic creation, explicit holder approval and direct MPT Payment rely on MPTokensV1, which the script checks again before any transaction. Amendment status comes from the live network rather than documentation availability badges.

Validation: strict TypeScript compilation; a transaction validation/serialization unit test; the five real testnet transactions; and a separate read-only verification of both balances and authorization flags.
