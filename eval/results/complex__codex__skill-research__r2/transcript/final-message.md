Implemented and ran the testnet demo. [result.json](/private/tmp/ws/9a2fbb457f7f/project/result.json) contains the issuance ID and holder addresses.

Verified at ledger **21144623**:

- **A:** 500, approved, unfrozen.
- **B:** 700, approved, frozen.
- **C:** 0, banned and unauthorized.
- **Global freeze:** lifted.

Strict TypeScript build, 10 tests, and independent ledger verification passed. [README](/private/tmp/ws/9a2fbb457f7f/project/README.md) includes usage, research, and recovery instructions.

**Compliance limitation:** native MPT locks permit direct issuer payments in both directions. The module blocks issuance while frozen, but holders can still redeem directly on-ledger. Therefore, the literal “freeze all movement” requirement remains unmet; the demo records these exceptions in [transaction evidence](/private/tmp/ws/9a2fbb457f7f/project/transaction-audit.json).