Everything is in place and verified end-to-end on testnet. Summary:

**Module** (`src/`): `MptComplianceIssuer` (`mptIssuer.ts`) — issuer-side compliance controls for an XRPL MPT issuance:
- `createIssuance()` — mints the issuance with allowlist (`RequireAuth`), freeze (`CanLock`), and clawback (`CanClawback`) enabled
- `approveHolder` / `revokeHolderAuthorization` — allowlist control
- `freezeHolder` / `unfreezeHolder`, `globalFreeze` / `globalUnfreeze` — freeze controls
- `clawback`, `banHolder` (claws back full balance + revokes authorization)
- `send`, `getHolderState`, `getIssuanceState`

One important finding from empirically testing against testnet: the ledger's native MPT lock only blocks transfers *between two holders* — a locked or globally-frozen holder can still receive (or send to) the issuer directly, since that's an intentional redemption carve-out. So `send()` independently checks freeze/authorization state and refuses locally (`ComplianceViolationError`) before submitting, so "frozen means frozen" actually holds for every transfer the module originates. This is documented in the class's doc comment. Allowlist revocation (used for bans) has no such carve-out — it blocks every direction at the protocol level.

**Demo** (`demo.ts`) ran successfully on testnet and produced the exact required end state:
- A: 500 tokens, frozen then unfrozen (not frozen now)
- B: sent 1000, clawed back 300 → holds 700, frozen at end
- C: sent 250, then banned → holds 0, unauthorized, can't receive again
- Global freeze applied and lifted

`result.json` was written with the real issuance ID and holder addresses, matching the requested schema.