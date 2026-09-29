Built and ran the TypeScript issuer module using `xrpl` 5.3.0.

Verified at testnet ledger **21144463**:

- A: **500**, approved, unfrozen.
- B: **700**, approved, frozen.
- C: **0**, banned; receipt remains blocked after recreating its holding.
- Global freeze lifted.

Build and all **9 tests** passed. Replaying the demo submitted no new transactions.

[result.json](/private/tmp/ws/963ba53783e9/project/result.json) · [Module](/private/tmp/ws/963ba53783e9/project/src/issuer.ts) · [Documentation](/private/tmp/ws/963ba53783e9/project/README.md)

**Protocol limitation:** native MPT freezes permit issuer transfers and redemption. The module blocks issuance during freezes, but cannot block holder redemption. Thus, absolute “no movement” freezes are not achievable with these native controls.