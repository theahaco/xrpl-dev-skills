Implemented the strict TypeScript module and ran the testnet demo successfully.

Verified final state:

| Holder | Balance | Status |
|---|---:|---|
| A | 500 | Approved, unfrozen |
| B | 700 | Approved, frozen |
| C | 0 | Banned, unauthorized |

Global freeze is off. Build and all 7 tests pass.

Files: [result.json](/private/tmp/ws/c9ce3e9aff14/project/result.json), [issuer module](/private/tmp/ws/c9ce3e9aff14/project/src/issuer.ts), [documentation](/private/tmp/ws/c9ce3e9aff14/project/README.md), [ledger verification](/private/tmp/ws/c9ce3e9aff14/project/verification.json).

**Compliance limitation:** MPT locks still permit redemption to the issuer. The demo confirmed this, so the literal “freeze all movement” requirement cannot be guaranteed by native MPT locks.