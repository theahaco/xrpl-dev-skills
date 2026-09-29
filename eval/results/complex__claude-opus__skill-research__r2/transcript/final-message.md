I built the issuer module and the demo, and ran the demo on testnet. Every step passed, and the ledger is now in the state you described. I checked that state by querying a testnet node directly, without going through my code.

**Research findings**
- **xrpl 5.3.0** (published 2026-09-16) is the latest. One changelog item mattered: since 5.0, the key type is inferred from the seed, so I set ed25519 explicitly for your `sEd…` seed. I also pinned TypeScript 7.0.2. For `@types/node` I used 24.19.0 rather than the newest 26.x, because your runtime is Node 24 and newer types could allow calls that don't exist at runtime.
- **Docs:** I read the xrpl.org pages for MPTokenIssuanceCreate, MPTokenIssuanceSet, MPTokenAuthorize, Clawback, Payment and MPTokenIssuanceDestroy, plus the MPTokenIssuance and MPToken ledger entries.
- **Testnet amendments:** the ones this relies on are enabled (`MPTokensV1`, `Clawback`). Several newer ones are off, including `DynamicMPT`, `ConfidentialTransfer`, `SingleAssetVault` and `fixCleanup3_4_0`.
- **rippled source:** I also read it to confirm exactly how freeze, approval and clawback behave. This turned up two things the docs don't make obvious (below).

**On-ledger result**
- **Issuance ID:** `014279910EAE7BF62D79DDB80C8F44CC63682242595B5C5E`, issued from your account. Freeze, allowlist, clawback and holder-to-holder transfers are enabled. It is not globally frozen, and 1,200 tokens are outstanding.
- **A** `rGtrjptgoCL77JgoWhdWAUmFSLb5LNzSCX`: approved, holds 500, not frozen. A was frozen and unfrozen during the demo.
- **B** `rXbrVPsB362BreDHJEJF8eQCsRu1r3qKM`: approved, was sent 1,000, had 300 clawed back, holds 700, frozen.
- **C** `rEFYd5jRtFeg9LDP5iB2EaEbfpVmov2t6t`: was approved and sent 250, then banned. C holds 0, is frozen, and is no longer approved. Removing C's approval is part of the ban, so C is not "approved" at the end.
- `result.json` is written in the format you asked for.

The demo also checks that each blocked action fails for the right reason, for example a frozen holder's transfer being rejected, or a payment to an unapproved or banned holder.

**Two ledger behaviours your compliance team should know about**
1. **A freeze only stops transfers between holders.** The ledger still lets you pay a frozen holder, and lets a frozen holder send tokens back to you. The module refuses to issue to a frozen holder or during a global freeze. It can't stop a frozen holder from sending tokens back to you.
2. **A ban can't be fully enforced on-ledger alone.** On testnet today, a banned holder can delete its emptied account entry for the token and create a new one, which drops the freeze. The demo does this with C. C still can't receive, because the new entry isn't approved. What keeps C out for good is that the module never re-approves an address on its ban list. That list lives in a file (`data/bans.json`) and should be moved into your compliance database for production.

**Design choices**
- **Ban sequence:** record the ban, remove approval, freeze, claw back everything, then re-read the ledger to confirm the holder holds nothing. If a ban is interrupted, running it again finishes it.
- **Capabilities left off:** the token doesn't allow escrow, DEX trading or confidential balances, because tokens moved there couldn't be clawed back. The module refuses to manage a token that has them.
- **Whole units in the demo:** I used an asset scale of 0 so "500" means exactly 500 on the ledger. The module handles any number of decimal places. For a real stablecoin you'd probably use 2 or 6.
- **Where things are stored:** the issuer seed is in `.env` and the holder seeds are in `.secrets/holders.json`. Both are gitignored.
- **Cost:** the run used about 15 test XRP to fund the holders, plus small transaction fees.

**Not done**
- There is no unit test suite. The testnet demo is the only test.
- I haven't committed anything.

Files are in `src/` (the module is `issuer.ts`, the demo is `demo.ts`); the README covers usage. Run `npm run demo` to do a fresh run, which creates a new token and new holders.