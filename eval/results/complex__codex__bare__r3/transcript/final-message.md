Built and ran successfully on testnet. Verified at ledger **21144576**:

- A: approved, **500**, unfrozen.
- B: approved, **700**, frozen.
- C: banned, **0**; new receipts rejected.
- Global freeze exercised and lifted.

Strict build and all **6 tests** pass.

Files: [result.json](/private/tmp/ws/a3c6d20ff220/project/result.json), [issuer module](/private/tmp/ws/a3c6d20ff220/project/src/issuer.ts), [verification evidence](/private/tmp/ws/a3c6d20ff220/project/verification.json), [documentation](/private/tmp/ws/a3c6d20ff220/project/README.md).

**Compliance limitation:** native MPT locks still allow redemption directly to the issuer, so they cannot satisfy an absolute “no movement” requirement. Production integration requirements and recovery procedures are documented. [XRPL reference](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)