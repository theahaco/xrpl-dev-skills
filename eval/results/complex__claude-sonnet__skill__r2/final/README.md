# MPT Issuer

Issuer-side compliance controls for a regulated, stablecoin-style token on
the XRP Ledger, built on [Multi-Purpose Tokens (MPTs)](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens).
Targets testnet.

## Controls

- **Allowlist** — the issuance is created with `RequireAuth`. Holders opt in,
  then the issuer approves them (`MptIssuer.approveHolder`) before they can
  hold or receive the token.
- **Clawback** — `MptIssuer.clawback` / `clawbackAll` reclaim any amount from
  any holder, issuer-initiated.
- **Per-holder freeze** — `freezeHolder` / `unfreezeHolder` lock or unlock a
  single holder's ability to send or receive.
- **Global freeze** — `globalFreeze` / `globalUnfreeze` stop all movement of
  the token, e.g. during an incident.
- **Ban** — `banHolder` claws back the holder's full balance, freezes them,
  and revokes their allowlist approval, so they end up holding zero and
  cannot receive the token again.

Every method waits for the transaction to validate and throws
`IssuerTransactionError` on anything short of `tesSUCCESS` — a `tec*` result
(claimed cost, no effect) is never treated as a soft success.

## Setup

```bash
npm install
cp .env.example .env   # set ISSUER_SEED to your testnet issuer's seed
```

## Usage

```ts
import { createTestnetClient, MptIssuer, optInHolder } from "./src";
import { Wallet } from "xrpl";

const client = createTestnetClient();
await client.connect();

const issuer = new MptIssuer(client, Wallet.fromSeed(process.env.ISSUER_SEED!));
const { issuanceId } = await issuer.createIssuance({
  metadata: { ticker: "RTS", name: "Regulated Test Stablecoin", icon: "...", asset_class: "rwa", issuer_name: "..." },
});

// Holder opts in with their own key, then the issuer approves them.
await optInHolder(client, holderWallet, issuanceId);
await issuer.approveHolder(issuanceId, holderWallet.address);

await issuer.send(issuanceId, holderWallet.address, "500");
```

## Demo

Exercises every control against testnet using the issuer account plus three
freshly generated holder accounts (A, B, C), then writes `result.json`:

```bash
npm run demo
```

`npm run typecheck` / `npm run build` run/compile under TypeScript strict
mode.

## Notes

- Holder opt-in (`optInHolder`) must be signed by the holder, so it isn't a
  method on `MptIssuer` (which only ever holds the issuer's key) — it's a
  standalone helper for callers that control holder keys, like the demo.
- `src/constants.ts` documents the two per-holder `MPToken` ledger-object
  flags (`lsfMPTLocked`, `lsfMPTAuthorized`) that aren't exported by `xrpl.js`
  and are reproduced from the XRPL protocol spec.
