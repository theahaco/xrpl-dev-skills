Everything is in place and untracked (not committed, since that wasn't requested). Here's a summary:

**What was built** (`/private/tmp/ws/fecd7fbdef17/project`):
- `src/index.ts` — strict TypeScript script using `xrpl` that: creates an MPT issuance with `tfMPTRequireAuth` (so only approved holders can hold it), funds a fresh testnet holder account via the faucet, has the holder opt in via `MPTokenAuthorize`, has the issuer approve that holder (`MPTokenAuthorize` with `Holder` set), sends 1,000 tokens via a `Payment` with an `MPTAmount`, then reads back the holder's balance (`ledger_entry` → `mptoken`) and total outstanding supply (`ledger_entry` → `mpt_issuance`).
- `tsconfig.json` (strict mode), `package.json` (`npm run build` / `npm start`), `.gitignore`.

**Ran against testnet successfully:**
- Issuer: `rx9ARa4VS1rYuZSHkgPAaHcAmPpYe1D5x`
- New holder (faucet-funded): `rczRPY1pkkcn6f9egABtU3Nn7LMSpZeFN`
- MPT issuance ID: `01427FB60A6E56D1286BBB37EA2E1D4FBA897B61BBE5BC65`
- Holder balance and total outstanding both read back as `1000`

`result.json` was written matching your requested schema exactly. One harmless note: the ledger emitted an advisory (not an error) that the metadata blob doesn't follow the optional XLS-89 JSON convention for explorers — the issuance itself succeeded fine; let me know if you'd like it reformatted to comply.