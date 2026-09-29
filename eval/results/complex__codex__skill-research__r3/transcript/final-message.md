Built and ran successfully on testnet using `xrpl` 5.3.0. Wrote [result.json](/private/tmp/ws/64505c916260/project/result.json).

Verified at ledger **21144799**:

- A: approved, **500**, unfrozen.
- B: approved, **700**, frozen.
- C: banned, **0**, unauthorized.
- Global freeze: off.

Strict build, eight tests, independent ledger verification, and an idempotent demo rerun passed.

**Compliance limitation:** native locks permit issuer exceptions. The module blocks frozen issuance; issuer DepositAuth blocks direct redemptions. All issuer signing must remain behind the module. Details, research, and recovery instructions are in [README.md](/private/tmp/ws/64505c916260/project/README.md).