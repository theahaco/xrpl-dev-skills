Built the strict TypeScript issuer module and ran the demo on testnet.

Verified final state:

- **A:** approved, 500 tokens, unfrozen.
- **B:** approved, 700 tokens after clawing back 300, frozen.
- **C:** banned, zero tokens, unauthorized.
- **Issuance:** globally unfrozen.

Files: [result.json](/private/tmp/ws/befbf2ae2882/project/result.json), [issuer module](/private/tmp/ws/befbf2ae2882/project/src/issuer.ts), [demo report](/private/tmp/ws/befbf2ae2882/project/demo-report.json), and [documentation](/private/tmp/ws/befbf2ae2882/project/README.md).

Build, 11 tests, and independent ledger verification passed. No unsettled transactions remain.

**Compliance limitation:** native MPT freezes still permit redemption directly to the issuer. The demo confirmed this through simulation. Thus, the implementation does **not** satisfy literal “no movement whatsoever”; issuer-wide DepositAuth was not enabled. See [XRPL’s documented semantics](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens#compliance-controls). Production signing, storage, and coordination requirements are documented in the README.