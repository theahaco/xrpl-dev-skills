Done. The project is in `/private/tmp/ws/a79fb1cb8aca/project`:

- `src/index.ts` — connects to `wss://s.altnet.rippletest.net:51233`, issues an MPT from your account with `tfMPTRequireAuth` (only approved holders can hold it) and `tfMPTCanTransfer`, funds a fresh holder account from the testnet faucet, has the holder opt in (`MPTokenAuthorize`) and the issuer approve it, sends 1,000 units via `Payment`, then reads the holder's `MPToken.MPTAmount` and the issuance's `OutstandingAmount` straight from `ledger_entry` and writes `result.json`.
- `tsconfig.json` — strict mode, Node16 module/resolution (required since the installed `typescript` is v7, which dropped the old `node` resolution option).
- `package.json` — `npm run build` / `npm start`.

It ran successfully against testnet:

- Issuance ID: `0142705CA06BEB1427F8EF01C28632FB10F1CB21DC60D6EB`
- Holder: `r4NjWwMTq9pY9UGrAuKKqwy9eiZFm4m9gH` (freshly funded via faucet)
- Holder balance / outstanding amount: `1000` / `1000` (read back from the ledger, not just assumed)

`result.json` is written in the exact requested shape.