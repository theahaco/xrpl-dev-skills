Built and ran the TypeScript demo on testnet. [result.json](/private/tmp/ws/3b2feb8ee57e/project/result.json) is ready.

Verified at ledger **21144585**:

- A: approved, **500**, unfrozen.
- B: approved, **700**, frozen.
- C: banned, **0**, unauthorized—even after recreating its holding.
- Global freeze: lifted.

Strict build and **10 tests pass**. [Implementation and documentation](/private/tmp/ws/3b2feb8ee57e/project/README.md).

**Compliance gap:** native MPT locks permit issuer-involving payments. The module blocks issuance while frozen, but the absolute “no movement” requirement remains unmet. Research and live-test findings are documented in [RESEARCH.md](/private/tmp/ws/3b2feb8ee57e/project/RESEARCH.md).