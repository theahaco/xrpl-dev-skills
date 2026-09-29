Everything is in place. Here's a summary of what was built and confirmed on testnet:

**Module** (`src/issuer.ts`, `src/errors.ts`, `src/index.ts`): a `MptIssuer` class wrapping an `xrpl.Client` + issuer `Wallet` for one MPT issuance, with:
- `createIssuance()` — mints the issuance with `tfMPTCanLock`, `tfMPTRequireAuth`, `tfMPTCanClawback`, `tfMPTCanTransfer`
- `approveHolder` / `revokeHolderApproval` (+ standalone `optInHolder` for the holder-signed opt-in) — the allowlist
- `pay`, `clawback`
- `freezeHolder` / `unfreezeHolder` — per-holder freeze
- `globalFreeze` / `globalUnfreeze`
- `banHolder` — claws back the full balance and revokes allowlist approval
- `getHolderState` / `getIssuanceState` for reading compliance state back

One important thing surfaced while testing against real testnet ledger behavior: rippled's native per-holder/global `lsfMPTLocked` flag only blocks the holder from *sending*, not receiving. To honestly satisfy "can't send or receive," `freezeHolder`/`unfreezeHolder` combine the lock with revoking/restoring the holder's allowlist authorization (which blocks both directions). This is documented in code comments. I verified this and the zero-balance JSON-field-omission quirk (rippled drops `MPTAmount`/`OutstandingAmount` when they hit zero, which needed defaulting) directly against testnet before finalizing.

**Demo** (`demo/demo.ts`) ran successfully against testnet, exercising every control and asserting that blocked actions are actually rejected on-ledger (not just assumed), producing the exact required end state:
- Issuance `01427D8D2EC7F1F7FCFED0B4396BF2AEAD753F5EA7E0C412`, issuer `rnGMcGhBx84YhFbRvL3PBnrTaZqk3byXSY`
- A: balance 500, unfrozen (was frozen then unfrozen)
- B: balance 700, frozen (1000 sent, 300 clawed back)
- C: balance 0, banned
- Global freeze exercised and lifted

`result.json` is written in the required format. A couple of one-off `node -e` probes and scratch files used to determine real ledger behavior were cleaned up; only the module, demo, and config files remain.