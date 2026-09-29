Built and ran successfully on testnet using `xrpl@5.3.0`.

Verified final state:
- A: approved, **500**, unfrozen.
- B: approved, **700**, frozen.
- C: banned, **0**, unauthorized.
- Token: globally unfrozen.

Files: [result.json](/private/tmp/ws/b3f7551315da/project/result.json), [issuer module](/private/tmp/ws/b3f7551315da/project/src/issuer.ts), [documentation](/private/tmp/ws/b3f7551315da/project/README.md).

Strict compilation, four tests, and independent ledger verification passed.

**Compliance caveat:** native MPT locks permit issuer exceptions. Strict freezes therefore combine issuer DepositAuth with module-level issuance checks and require exclusive control of issuer signing keys. These limits and the live test evidence are documented.