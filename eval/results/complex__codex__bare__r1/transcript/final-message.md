Built and ran against testnet. [result.json](/private/tmp/ws/a4eba0832ea6/project/result.json) contains the issuance ID and holder addresses.

Verified at ledger **21144347**:

- A: **500**, approved, unfrozen.
- B: **700**, approved, frozen.
- C: **0**, banned; receipt attempts rejected.
- Global freeze lifted.

Strict TypeScript build and all four tests pass. Module, demo, audit records, and integration guidance are included.

**Compliance limitation:** MPT freezes still permit redemption directly to the issuer, so absolute “no movement” cannot be guaranteed. [XRPL documentation](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens)