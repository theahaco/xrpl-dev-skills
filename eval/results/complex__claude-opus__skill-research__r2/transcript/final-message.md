I've built the issuer module and demo and run the demo against testnet. Every check passed, and the final ledger state matches what you asked for. I also confirmed that state with direct RPC queries that don't go through my code.

**`result.json`**
```json
{
  "issuanceId": "0142A0FA229EA439CCE822725C77073B54504996DC1798D4",
  "holders": {
    "A": "rBEcfE98XHfGvVYLAxwsrDjq3TPdR7fLmD",
    "B": "r1owxQbmF4JMs7gAv2eD2svSgDmhuyWac",
    "C": "r39G2Ra9F8xucJNLu4WFdwmk6yKVEfoHef"
  }
}
```

**Final state on the ledger:** the token is issued from your account with holder approval, freezing, clawback and holder-to-holder transfers enabled, and it is not globally frozen. A holds 500 (approved, not frozen). B holds 700 (approved, frozen). C holds 0 (approval revoked, frozen, on the ban list). Total supply in circulation is 1,200. Your account has about 91 XRP left.

**Research findings that shaped the design**
- **Versions:** xrpl 5.3.0 is the latest (released 2026-09-16). v5 no longer picks the key type for a seed by default, so the code sets it explicitly. TypeScript is 7.0.2 and @types/node is 26.6.3.
- **Testnet:** runs rippled 3.4.1. The core MPT and clawback amendments are enabled. **`DynamicMPT` is not**, so the token's capabilities can't be changed after creation; the module refuses to manage a token that lacks any of them.
- **Also not enabled: `fixCleanup3_4_0`.** Without it, a banned holder with an empty, frozen token record can delete it and create a new one. The demo shows C doing exactly that. The new record starts unapproved, so the ledger still rejects every payment to C. The ban list is therefore the lasting record, and `enforceBans()` re-freezes such records.

**Where the ledger alone doesn't meet your spec:** the rippled source shows the issuer can pay a frozen holder, even during a global freeze. A freeze only blocks transfers between holders. So the module's `issue()` refuses frozen holders and refuses everything during a global freeze. **Your backend must send tokens only through this module**, or a frozen holder could still receive tokens from the issuer. Frozen holders can also still send tokens back to the issuer, which destroys them; the ledger allows this.

**How each control was tested:** the demo checks each one twice. First the module must refuse the forbidden action. Then a transaction that skips the module must be rejected by the ledger itself. There are also 11 unit tests (amount conversion and the ban list), which pass. The full run log is in `demo-output.log`.

**Things to know**
- **Decimals:** the demo token has no decimal places, so "500" is exactly 500 units on the ledger. The module supports any number of decimals; a real stablecoin would usually use 2 or 6. Because capabilities are fixed at creation, the production token would be a new issuance.
- **Secrets:** your seed is in `.env`, and the three holder seeds are in `.secrets/holders.json`. Both are git-ignored and readable only by you. I haven't committed anything.
- **Production:**
  - Replace the JSON-file ban list with your compliance database.
  - Run only one module instance per issuer account.
  - Move signing into a key-management service or hardware module.
  - The README lists these and the other design notes.

Files are in the project directory:
- `src/issuer.ts`
- `src/submitter.ts`
- `src/banList.ts`
- `src/amount.ts`
- `src/holder.ts`
- `src/config.ts`
- `scripts/demo.ts`
- `test/`
- `README.md`