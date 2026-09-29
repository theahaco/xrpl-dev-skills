I built the issuer module and the demo, ran the demo on testnet with your account as issuer, and wrote `result.json`. I then read the ledger objects directly from testnet, without going through my code, and they match the state you asked for.

```json
{
  "issuanceId": "0142A1B483690BC6A67EC8772D60A358D540C072EB0D35A7",
  "holders": {
    "A": "rLS32XYgycLcjcam7DCLKDoW4BeLH1ENgF",
    "B": "rdz3aznWHaQpSXC1DtEp3yyQra3Hud2kk",
    "C": "rJRboMKY4pcKXDQyhC3LpzVUX962Mt3zHA"
  }
}
```

| | Balance | Approved | Frozen |
|---|---|---|---|
| A | 500 | yes | no (frozen, then unfrozen) |
| B | 700 (sent 1,000, 300 clawed back) | yes | yes |
| C | 0 (sent 100, all clawed back) | no, banned | yes |

The token is not globally frozen at the end; it was frozen and unfrozen during the demo. It has the allowlist, freeze and clawback controls switched on, and holders can send to each other. 1,200 tokens are in circulation.

The demo checks every control twice: the module refuses the forbidden action, and the same transaction sent directly to the ledger is rejected. For example, a frozen A can't send or receive, nothing moves during the global freeze, and payments to banned C fail from both you and A. The module also refuses to re-approve, unfreeze or issue to C.

**Research findings that shaped the design:**
- **Versions:** `xrpl` 5.3.0 (released 16 Sept, changelog read), TypeScript 7.0.2, and testnet running rippled 3.4.1. I used `@types/node` 24 rather than 26 so the type definitions match your Node 24 runtime.
- **Frozen holders:** on the XRP Ledger, a freeze only blocks transfers between holders. You as issuer can still pay a frozen holder, and they can still send tokens back to you. So the module refuses to issue to anyone frozen, unapproved or banned, and refuses to issue at all during a global freeze. Your backend should only pay holders through this module.
- **Settings are permanent:** the amendment that allows changing a token's settings after creation (DynamicMPT) is not enabled on testnet. The flags, metadata and decimal places can never be changed.
- **Escrow and trading are off:** escrow for these tokens is live on testnet, and clawback can't reach escrowed tokens. I left escrow and DEX trading switched off so a holder can't move tokens out of reach of a clawback or ban.
- **Bans:** a banned address is removed from the allowlist, so the ledger rejects every payment to it. The module also records bans in a registry so it never re-approves that address.

**Decision for you:** the token has 2 decimal places, as is usual for a stablecoin. So on the ledger, A's balance shows as `50000` base units, which means 500.00 tokens. Explorers that read the decimal setting will show 500. If you'd rather have whole units only, that needs a new token, because this setting can't be changed.

**Other things to know:**
- **Placeholder metadata:** the token's name, ticker (`RUSD`), issuer name and icon URL are placeholders. They can't be edited, so real values need a new token.
- **Local secrets:** your seed is in `.env`, and the three holder seeds are in `.secrets/`. The audit log and ban registry are in `state/`. All of these are excluded from git.
- **Nothing committed:** I haven't made any commits.
- **Test issuance:** before using your account I did a full dry run from a throwaway faucet account, so a failure halfway through wouldn't leave a stray token on yours. That test token is still on testnet under the throwaway account.
- **Funds:** your account now owns only the one token and has about 85 test XRP left; each holder was funded with 5 XRP.
- **Tests:** there are 5 unit tests for amount conversion and the ban registry, and they pass. The rest was tested by the dry run and the real run.

**Production caveats:**
- **Ban registry:** the file-based registry only works for a single process. Replace it with your compliance database.
- **One instance per token:** the module processes actions one at a time only within a single instance. Run one instance per token, or add a shared lock.

Files are in the project directory:
- `src/issuer.ts`: the issuer module with all the controls
- `src/submit.ts`: sends transactions and waits for the final ledger result
- `src/banRegistry.ts`: the persistent record of banned addresses
- `scripts/demo.ts`: the demo
- `README.md`: usage and the behaviour described above

Run `npm test` for the unit tests and `npm run demo` to repeat the demo; a repeat run creates a new token and new holders.