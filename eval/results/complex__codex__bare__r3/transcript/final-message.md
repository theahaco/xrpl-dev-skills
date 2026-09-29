Built the strict TypeScript issuer module and ran the demo on testnet.

Verified final state:

- A: approved, **500**, unfrozen.
- B: approved, **700**, frozen.
- C: **0**, banned; receiving remains blocked after recreating its holding.
- Global freeze: off.

Build and all **14 tests passed**. Rerunning the demo submitted no new transactions.

Files: [result.json](/private/tmp/ws/f6efaa04b21d/project/result.json), [transaction evidence](/private/tmp/ws/f6efaa04b21d/project/demo-evidence.json), [API and recovery documentation](/private/tmp/ws/f6efaa04b21d/project/README.md).

**Protocol limitation:** native MPT freezes still permit redemption to the issuer, so absolute “no movement” cannot be guaranteed. This was confirmed on testnet and documented. [XRPL controls](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)