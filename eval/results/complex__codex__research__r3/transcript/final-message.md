Built and ran the strict TypeScript module using `xrpl` **5.3.0**. [result.json](/private/tmp/ws/c9e7f34dce58/project/result.json) is ready.

Verified at testnet ledger **21144746**:

- A: approved, **500**, unfrozen.
- B: approved, **700**, frozen.
- C: **0**, banned; receiving remains blocked after recreating its holding.
- Global freeze lifted.

Eight unit tests passed, plus 42 validated demo transactions.

**Compliance limitation:** native freezes permit direct payments involving the issuer. The module blocks frozen issuance, but cannot prevent holder redemption—so literal “no movement” is not achievable with these MPT controls.

[Implementation and operating notes](/private/tmp/ws/c9e7f34dce58/project/README.md) · [Research](/private/tmp/ws/c9e7f34dce58/project/research/README.md) · [Demo evidence](/private/tmp/ws/c9e7f34dce58/project/demo-evidence.json)