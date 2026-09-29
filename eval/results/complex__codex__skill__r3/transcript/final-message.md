Implemented the strict TypeScript issuer module and ran the testnet demo using your issuer account.

Verified at ledger **21144637**:

- **A:** approved, 500 tokens, unfrozen.
- **B:** approved, 700 tokens after 300 clawback, frozen.
- **C:** banned, zero tokens, unauthorized.
- **Token:** globally unfrozen.

Build, 12 tests, and idempotent demo replay passed.

Files: [result.json](/private/tmp/ws/46cf5828393f/project/result.json), [issuer module](/private/tmp/ws/46cf5828393f/project/src/issuer.ts), [documentation](/private/tmp/ws/46cf5828393f/project/README.md).

**Compliance limitation:** native MPT freezes still permit redemption to the issuer. The demo verified this exception; literal “all movement stops” is not satisfied by native MPT locking. [Protocol reference](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)