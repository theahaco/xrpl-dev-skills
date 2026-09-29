Built and ran on testnet. [result.json](/private/tmp/ws/cb85358b7728/project/result.json) is written.

Verified final state:
- A: approved, 500 tokens, unfrozen.
- B: approved, 700 tokens, frozen.
- C: banned, zero tokens; receipts rejected even after recreating its holding.
- Global freeze lifted.

Strict build and 9 tests pass. Saved 37 transaction receipts in [audit.json](/private/tmp/ws/cb85358b7728/project/audit.json).

**Limitation:** XRPL native freezes still permit redemption to the issuer; they cannot guarantee literally zero movement. Integration instructions and production deployment requirements are in [README.md](/private/tmp/ws/cb85358b7728/project/README.md).