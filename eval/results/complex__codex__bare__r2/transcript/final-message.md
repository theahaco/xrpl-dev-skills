Implemented and ran on testnet. Final state verified at ledger **21144433**:

- **A:** 500, approved, unfrozen.
- **B:** 700, approved, frozen.
- **C:** 0, banned and unauthorized.
- **Global freeze:** off.

Strict TypeScript build and all **11 tests** pass. The demo recorded 40 validated transactions, including expected rejections.

Files: [result.json](/private/tmp/ws/bd8f72fd81d5/project/result.json), [issuer module](/private/tmp/ws/bd8f72fd81d5/project/src/issuer.ts), [documentation](/private/tmp/ws/bd8f72fd81d5/project/README.md), [transaction audit](/private/tmp/ws/bd8f72fd81d5/project/audit.json).

**Protocol limitation:** MPT freezes still permit redemption to the issuer, so literal “all movement” blocking is unavailable. This exception was demonstrated and documented. [XRPL reference](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens#compliance-controls)