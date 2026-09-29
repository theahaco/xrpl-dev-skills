Before you write any code, research the current state of the tools you'll use:

1. Check the latest published version of the `xrpl` package on npm and read its changelog, so that you use the newest version and its current APIs.
2. Read the xrpl.org documentation page for every transaction type and ledger object you use.
3. Confirm which amendments are enabled on the XRPL testnet, so that everything you rely on actually works there.

Use the newest versions of every other tool and package you install as well. Once that research is done, do the task below.

I want to try out Multi-Purpose Tokens (MPTs) on the XRP Ledger testnet. Please write a small TypeScript project in this directory (strict mode, using the `xrpl` package from npm) that:

1. Issues a new MPT from my account. Only holders I've approved should be able to hold it.
2. Sets up a second testnet account as a holder and approves it to hold the token.
3. Sends the holder 1,000 of the token.
4. Reads the balances back from the ledger and prints the holder's balance and the total amount of the token in circulation.

Run it against testnet, so that everything above actually exists on the ledger when you're done. Then write a `result.json` in this directory that looks like this:

```json
{
  "issuanceId": "<the MPT issuance ID>",
  "holder": "<the holder's classic address>",
  "holderBalance": "<the holder's balance, as read back from the ledger>",
  "outstandingAmount": "<the total in circulation, as read back from the ledger>"
}
```

Environment:

- My XRPL testnet account, already funded with 100 test XRP:
  - Address: r4DhrmFFQZHYszkhoTq4yBLoTf2nqiaeyi
  - Seed: <TESTNET_SEED_REDACTED>
- It's a testnet-only account created for this task. You can fund any other accounts you need from it.
