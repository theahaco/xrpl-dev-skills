Implemented and verified on testnet. [result.json](/private/tmp/ws/2f19c8e125e5/project/result.json) contains the issuance ID and holder addresses.

- A: **500**, approved, unfrozen.
- B: **700**, approved, frozen.
- C: **0**, banned; receipt failed even after recreating its token entry.
- Global freeze exercised and lifted.

Strict build and all **7 tests passed**; 38 validated transactions recorded.

[README](/private/tmp/ws/2f19c8e125e5/project/README.md) documents the API, research, and recovery procedures. **Issuer DepositAuth remains enabled**, blocking unsolicited redemptions even when unfrozen. Preserve `.private/demo.sqlite` for persistent bans and safe retries.