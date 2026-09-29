Built and ran successfully on testnet. [result.json](/private/tmp/ws/4a92b681cc59/project/result.json) contains the issuance ID and holder addresses.

Verified at ledger **21144546**:

- A: **500**, approved, unfrozen.
- B: **700**, approved, frozen.
- C: **0**, banned; subsequent receipts rejected.
- Global freeze: **off**, after exercising both states.

Strict build and **12 tests passed**. [Documentation and evidence](/private/tmp/ws/4a92b681cc59/project/README.md).

**Freeze caveat:** Native locks permit issuer-related payments. Enforcement therefore combines locks, module mint checks, and account-wide issuer **DepositAuth**, which remains enabled and blocks direct redemption even when unfrozen. Unrestricted issuer signing can bypass application policy.