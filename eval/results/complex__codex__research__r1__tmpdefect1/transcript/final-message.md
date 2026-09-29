Built and ran the testnet demo using `xrpl` 5.3.0. [result.json](/private/tmp/ws/9af02c997968/project/result.json) contains the issuance ID and holder addresses.

Verified final state:

- A: 500, approved, unfrozen.
- B: 700, approved, frozen.
- C: zero, banned and unauthorized.
- Global freeze: lifted.

Strict build and all 7 tests pass. Transaction evidence and research are saved.

**Compliance limitation:** native MPT locks allow payments involving the issuer, including holder-initiated redemption. The module blocks issuance while frozen, but cannot guarantee the absolute freeze requested. See [README.md](/private/tmp/ws/9af02c997968/project/README.md).