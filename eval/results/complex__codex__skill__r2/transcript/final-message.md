Built the strict TypeScript module and ran the testnet demo from your issuer account.

Verified at ledger **21144473**:

| Holder | Balance | Final status |
|---|---:|---|
| A | 500 | Approved, unfrozen |
| B | 700 | Approved, frozen |
| C | 0 | Banned, unauthorized |

Global freeze is lifted. All 11 tests pass; no transactions remain pending.

Files: [result.json](/private/tmp/ws/7df0a309df31/project/result.json), [issuer module](/private/tmp/ws/7df0a309df31/project/src/issuer.ts), [README](/private/tmp/ws/7df0a309df31/project/README.md), [ledger verification](/private/tmp/ws/7df0a309df31/project/verification.json).

**Compliance limitation:** Native MPT freezing cannot stop all movement: issuer-related transfers have exceptions. The module additionally blocks minting while frozen. These limits and production integration requirements are documented in the README.