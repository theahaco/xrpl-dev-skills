Built and ran the TypeScript issuer module using `xrpl` 5.3.0.

Verified on testnet at ledger **21134410**:

- A: **500**, approved, unfrozen.
- B: **700**, approved, frozen.
- C: **0**, banned and unauthorized.
- Token: globally unfrozen.

Saved [result.json](/private/tmp/ws/5c5ddab4908f/project/result.json), [ledger verification](/private/tmp/ws/5c5ddab4908f/project/verification.json), and [transaction evidence](/private/tmp/ws/5c5ddab4908f/project/demo-audit.json). Strict build and all 8 tests pass.

**Compliance limitation:** native MPT freezes still permit issuer payments, redemptions, and clawbacks. Live tests confirmed this, so the absolute “no movement” requirement is **not satisfied**. Details, research, API usage, and recovery instructions are in [README.md](/private/tmp/ws/5c5ddab4908f/project/README.md).