Built the TypeScript issuer module and ran the testnet demo. [result.json](/private/tmp/ws/b1c2e99b12a0/project/result.json) is written.

Verified at ledger **21134483**:

- A: approved, **500**, unfrozen.
- B: approved, **700**, frozen after a 300 clawback.
- C: banned, **0**, subsequent receipts rejected.
- Global freeze exercised and lifted.

Build and **9 tests passed**; 38 validated transaction receipts are recorded.

**Compliance limitation:** live tests confirmed that MPT locks still permit payments involving the issuer. Backend mint guards are implemented, but native MPTs cannot guarantee an absolute movement halt.

See the [issuer module](/private/tmp/ws/b1c2e99b12a0/project/src/issuer.ts) and [README](/private/tmp/ws/b1c2e99b12a0/project/README.md) for usage, recovery procedures, evidence, and deployment requirements.