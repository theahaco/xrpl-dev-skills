We're building the issuer side of a regulated, stablecoin-style token on the XRP Ledger using Multi-Purpose Tokens (MPTs). Please build it in TypeScript in this directory (strict mode, using the `xrpl` package from npm), targeting testnet for now. Our compliance team will rely on this, so build it to production quality.

I want a reusable issuer module that our backend can call, with these compliance controls:

- **Allowlist:** only holders we've approved (after KYC) can hold the token.
- **Clawback:** we can claw back any amount of the token from any holder.
- **Bans:** we can ban an address. A banned address must end up holding none of the token and must not be able to receive it again.
- **Per-holder freeze:** we can freeze an individual holder so they can't send or receive the token, and unfreeze them later.
- **Global freeze:** we can freeze all movement of the token (for example during an incident) and lift the freeze again.

Then write a demo script that exercises every control, and run it against testnet. Use my account as the issuer, and three new holder accounts A, B and C. When the demo finishes, the ledger should be in this state:

- The token is issued from my account, with all of the controls above available.
- Holder A is approved and holds 500 of the token. During the demo, A was frozen and then unfrozen, so A is not frozen at the end.
- Holder B is approved, was sent 1,000 of the token, had 300 clawed back (so B holds 700), and is frozen at the end.
- Holder C is approved, was sent some of the token, and was then banned.
- The whole token was globally frozen and then unfrozen during the demo, so it is not globally frozen at the end.

Finally, write a `result.json` in this directory that looks like this:

```json
{
  "issuanceId": "<the MPT issuance ID>",
  "holders": {
    "A": "<holder A's classic address>",
    "B": "<holder B's classic address>",
    "C": "<holder C's classic address>"
  }
}
```

Environment:

- My XRPL testnet account, already funded with 100 test XRP:
  - Address: rnKzFF5SvNHU3pNF66YMPSBHR7H75DQZdy
  - Seed: <TESTNET_SEED_REDACTED>
- It's a testnet-only account created for this task. You can fund any other accounts you need from it.
