Implemented and ran on testnet. Strict build and all 10 tests pass.

Verified final state:
- A: approved, 500, unfrozen.
- B: approved, 700, frozen.
- C: zero balance, banned; receiving remains blocked after re-opting in.
- Global freeze: off.

Files: [result.json](/private/tmp/ws/749e7759bb1d/project/result.json), [audit receipts](/private/tmp/ws/749e7759bb1d/project/audit.json), [module and usage documentation](/private/tmp/ws/749e7759bb1d/project/README.md).

**Compliance limitation:** [native MPT freezes permit redemption to the issuer](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens), so absolute “no movement” cannot be guaranteed. Production deployment requirements are documented.