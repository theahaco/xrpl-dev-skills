Everything builds cleanly and the demo has been verified end-to-end on testnet, with the final on-ledger state independently confirmed.

## Summary

Built a TypeScript issuer module for a compliance-controlled MPT (Multi-Purpose Token) on XRPL testnet, in `/private/tmp/ws/3752ba06ec4b/project`:

- **`src/mptIssuer.ts`** — reusable `MptIssuer` class: `createIssuance` (allowlist + clawback + lock capability), `approveHolder`/`revokeHolderApproval` (allowlist), `send`/`clawback`, `freezeHolder`/`unfreezeHolder`, `globalFreeze`/`globalUnfreeze`, and `banHolder` (clawback-to-zero + revoke). Plus a standalone `optInHolder` for the holder-signed side of allowlisting.
- **`src/demo.ts`** — exercises every control against testnet with three fresh holder accounts, including negative-path proofs (blocked stranger payment, blocked frozen-holder transfers at both the protocol level and an app-level guard, blocked payment to a banned holder), and writes `result.json`.
- **`result.json`** — written by the verified run, holding the live issuance ID and holder addresses.

Two non-obvious protocol findings worth noting (both handled in code, confirmed against live rippled 3.4.1 on testnet, not just docs):
1. MPT per-holder/global lock only blocks the **holder's own** outgoing transfers — it doesn't stop the issuer from paying a locked holder directly. I added an app-level guard in `send()` so "frozen ⇒ can't receive" is actually enforced, and the demo separately proves the "can't send" half via a raw holder-signed payment that the ledger itself rejects with `tecLOCKED`.
2. The ledger omits the `MPTAmount` field entirely when a holder's balance is zero, so a naive read produced `balance: undefined` for a zero-balance holder — fixed with an explicit `?? '0'` fallback.

Final verified ledger state: A holds 500 (unfrozen), B holds 700 (frozen), C holds 0 and is unauthorized (banned), issuance outstanding = 1200, not globally locked — matching the requested end state exactly, confirmed independently via direct `ledger_entry` queries.