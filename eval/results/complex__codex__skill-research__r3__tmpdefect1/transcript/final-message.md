Built and ran the testnet demo. [result.json](/private/tmp/ws/953605732b65/project/result.json) contains the issuance ID and holder addresses.

Verified at ledger **21134577**:

- A: **500**, approved, unfrozen.
- B: **700**, approved, frozen.
- C: **0**, banned and unauthorized.
- Global freeze: **off**, after successful freeze/unfreeze.

Strict build and **9 tests passed**. Rerunning submitted no duplicate transactions.

**Compliance caveat:** native MPT locks exempt issuer transfers. Full freeze enforcement therefore combines ledger locks, issuer DepositAuth, and backend mint guards, requiring exclusive issuer signing through this module.

[Module](/private/tmp/ws/953605732b65/project/src/issuer.ts) · [Documentation](/private/tmp/ws/953605732b65/project/README.md) · [Research](/private/tmp/ws/953605732b65/project/RESEARCH.md) · [Transaction evidence](/private/tmp/ws/953605732b65/project/evidence/transactions.json)