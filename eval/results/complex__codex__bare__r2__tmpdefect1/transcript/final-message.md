Built the strict TypeScript issuer module and ran the testnet demo.

Verified final state:

- A: 500, approved, unfrozen.
- B: 700, approved, frozen.
- C: 0, banned and unauthorized.
- Global freeze lifted.

Build, four tests, and ledger verification passed. [result.json](/private/tmp/ws/ed6a7359ca97/project/result.json) contains the issuance ID and holder addresses.

**Compliance limitation:** native MPT freezes still permit redemption to the issuer, confirmed on testnet. Thus the literal “no movement” requirement remains unmet. Implementation details and operating requirements are in [README.md](/private/tmp/ws/ed6a7359ca97/project/README.md).