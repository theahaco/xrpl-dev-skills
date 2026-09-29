# Multi-Purpose Tokens (MPTs)

MPTs are fungible tokens without trust lines. The issuer creates one `MPTokenIssuance`, each holder owns one `MPToken` entry, and the token's capabilities are chosen once, at creation. This file covers issuing, approving holders, paying, reading balances back, and the compliance controls (lock, clawback, ban) with xrpl.js 5.x in strict TypeScript.

Every snippet here type-checks with `xrpl@5.3.0` and TypeScript 7 in strict mode, and the whole flow ran end to end on testnet (rippled 3.4.1) in September 2026. The snippets use `submitOrThrow` and `requireEnv` from [client-sdk.md](client-sdk.md#submit-and-require-success).

## Before you start

**Check the amendment.** MPTs need `MPTokensV1` on the network you target:

```typescript
import { Client } from 'xrpl';

/** True if the named amendment is enabled on the connected network. */
export async function amendmentEnabled(client: Client, name: string): Promise<boolean> {
  const response = await client.request({ command: 'feature', feature: name });
  return Object.values(response.result).some((f) => f.name === name && f.enabled);
}
```

**Settings are permanent.** Unless `DynamicMPT` is enabled (it was not on testnet in September 2026), the flags, `AssetScale`, `TransferFee` and `MPTokenMetadata` cannot change after creation. Decide them before the first transaction.

**Reserves.** The issuance costs the issuer one owner reserve, and each holder's `MPToken` costs that holder one. Fund each new holder account with the base reserve, one owner reserve and fees (1 + 0.2 XRP plus fees on testnet today; read `server_info` for live values).

## Capabilities are chosen at creation

| `MPTokenIssuanceCreateFlags` | Value | Enables |
| --- | --- | --- |
| `tfMPTCanLock` | `0x02` | Locking (freezing) one holder or the whole token |
| `tfMPTRequireAuth` | `0x04` | An allow-list: holders need the issuer's approval |
| `tfMPTCanEscrow` | `0x08` | Escrowing the token |
| `tfMPTCanTrade` | `0x10` | Trading on the DEX |
| `tfMPTCanTransfer` | `0x20` | Payments between holders (issuer to holder and back always works) |
| `tfMPTCanClawback` | `0x40` | Clawback by the issuer |

A compliance-controlled token needs `tfMPTRequireAuth | tfMPTCanLock | tfMPTCanClawback`, plus `tfMPTCanTransfer` if holders may pay each other. A capability left out at creation can never be added.

## Amounts are raw integers

Every MPT amount on the ledger is an **integer string in the token's smallest unit**: `Amount.value` in a Payment or Clawback, `MaximumAmount`, `OutstandingAmount` and a holder's `MPTAmount`. `AssetScale` only tells display code where to put the decimal point.

With `AssetScale: 2`, "1,000 tokens" is `value: '100000'`. Sending `value: '1000'` sends 10.00 tokens, and every balance you read back is 100 times smaller than the task asked for. Use `AssetScale: 0` unless the token needs decimals, and convert display amounts in one place:

```typescript
/** Convert a display amount ('12.5') to the raw integer string MPT fields expect. */
export function toRawUnits(display: string, assetScale: number): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(display);
  const whole = match?.[1];
  if (whole === undefined) throw new Error(`Not a non-negative decimal: ${display}`);
  const fraction = match?.[2] ?? '';
  if (fraction.length > assetScale) {
    throw new Error(`${display} has more than ${assetScale} decimal places`);
  }
  return BigInt(whole + fraction.padEnd(assetScale, '0')).toString();
}
```

`TransferFee` is in units of 0.001% (`100` is 0.1%, the maximum `50000` is 50%) and requires `tfMPTCanTransfer`. Without that flag, xrpl.js rejects the transaction before it is sent.

## Issue the token and get its ID

```typescript
import { Client, MPTokenIssuanceCreateFlags, Wallet, type MPTokenIssuanceCreate } from 'xrpl';

const client = new Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
const issuer = Wallet.fromSeed(requireEnv('XRPL_ISSUER_SEED'));

const assetScale = 0;
// Typing the transaction as MPTokenIssuanceCreate types its metadata too.
const create: MPTokenIssuanceCreate = {
  TransactionType: 'MPTokenIssuanceCreate',
  Account: issuer.address,
  AssetScale: assetScale,
  MaximumAmount: toRawUnits('1000000', assetScale),
  Flags:
    MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
    MPTokenIssuanceCreateFlags.tfMPTCanLock |
    MPTokenIssuanceCreateFlags.tfMPTCanClawback |
    MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
};
const created = await submitOrThrow(client, create, issuer);
const meta = created.result.meta;
const issuanceId = typeof meta === 'object' ? meta.mpt_issuance_id : undefined;
if (issuanceId === undefined) throw new Error('No mpt_issuance_id in the metadata');
```

The issuance ID is a 48-character hex string. Save it: every later transaction names it.

## Approve a holder

Two transactions, in this order: the holder opts in, then the issuer approves the holder (needed with `tfMPTRequireAuth`).

```typescript
await submitOrThrow(client, {
  TransactionType: 'MPTokenAuthorize',
  Account: holder.address, // the holder creates its MPToken entry
  MPTokenIssuanceID: issuanceId,
}, holder);

await submitOrThrow(client, {
  TransactionType: 'MPTokenAuthorize',
  Account: issuer.address, // the issuer approves that holder
  MPTokenIssuanceID: issuanceId,
  Holder: holder.address,
}, issuer);
```

Paying a holder the issuer has not approved fails with `tecNO_AUTH`. That failure is validated on the ledger, so `submitAndWait` resolves with it instead of throwing.

## Pay

```typescript
await submitOrThrow(client, {
  TransactionType: 'Payment',
  Account: issuer.address,
  Destination: holder.address,
  Amount: { mpt_issuance_id: issuanceId, value: toRawUnits('1000', assetScale) },
}, issuer);
```

## Read balances back from the ledger

Read from the validated ledger, not from the amounts you sent. The issuance's `OutstandingAmount` is the total in circulation; a holder's `MPTAmount` is its balance. Both are raw units.

```typescript
import { Client, LedgerEntry, RippledError } from 'xrpl';

// Holder-side MPToken flags. xrpl.js 5.3.0 exports no enum for these.
const lsfMPTLocked = 0x01;
const lsfMPTAuthorized = 0x02;

export interface HolderState {
  rawBalance: string;
  authorized: boolean;
  locked: boolean;
}

/** xrpl.js 5.3.0 leaves MPToken out of the LedgerEntry union, so narrow at runtime. */
function isMPToken(node: unknown): node is LedgerEntry.MPToken {
  return (
    typeof node === 'object' &&
    node !== null &&
    'LedgerEntryType' in node &&
    node.LedgerEntryType === 'MPToken'
  );
}

/** True when rippled rejected a request with this error code, such as entryNotFound. */
export function isRippledError(error: unknown, code: string): boolean {
  if (!(error instanceof RippledError)) return false;
  const data: unknown = error.data;
  return typeof data === 'object' && data !== null && 'error' in data && data.error === code;
}

/** The holder's MPToken state, or undefined if the holder never opted in. */
export async function readHolder(
  client: Client,
  issuanceId: string,
  holder: string,
): Promise<HolderState | undefined> {
  try {
    const response = await client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account: holder },
      ledger_index: 'validated',
    });
    const node: unknown = response.result.node;
    if (!isMPToken(node)) throw new Error('ledger_entry did not return an MPToken');
    // rippled omits MPTAmount when the balance is zero, although the type marks it required.
    const amount: string | undefined = node.MPTAmount;
    return {
      rawBalance: amount ?? '0',
      authorized: (node.Flags & lsfMPTAuthorized) !== 0,
      locked: (node.Flags & lsfMPTLocked) !== 0,
    };
  } catch (error) {
    if (isRippledError(error, 'entryNotFound')) return undefined;
    throw error;
  }
}

export async function readIssuance(
  client: Client,
  issuanceId: string,
): Promise<LedgerEntry.MPTokenIssuance> {
  const response = await client.request({
    command: 'ledger_entry',
    mpt_issuance: issuanceId,
    ledger_index: 'validated',
  });
  const node = response.result.node;
  if (node.LedgerEntryType !== 'MPTokenIssuance') {
    throw new Error(`Expected an MPTokenIssuance, got ${node.LedgerEntryType}`);
  }
  return node;
}
```

The issuer's `account_objects` does not list holders' `MPToken` entries, and rippled has no call that lists every holder. Keep your own record of the holders you approve.

## Compliance controls

### Lock (freeze) one holder or the whole token

`MPTokenIssuanceSet` with `tfMPTLock` or `tfMPTUnlock`. Include `Holder` to lock one holder; leave it out to lock the whole token. The issuance needs `tfMPTCanLock`.

```typescript
import { MPTokenIssuanceSetFlags } from 'xrpl';

await submitOrThrow(client, {
  TransactionType: 'MPTokenIssuanceSet',
  Account: issuer.address,
  MPTokenIssuanceID: issuanceId,
  Holder: holder.address, // leave out to lock every holder
  Flags: MPTokenIssuanceSetFlags.tfMPTLock, // tfMPTUnlock lifts it
}, issuer);
```

A lock stops holders moving the token between themselves. It does not stop the issuer. Observed on testnet with one holder locked:

| While the holder is locked | Result |
| --- | --- |
| Another holder pays the locked holder | `tecLOCKED` |
| The locked holder pays another holder | `tecLOCKED` |
| The issuer pays the locked holder | succeeds |
| The locked holder pays the issuer | succeeds |
| The issuer claws back from the locked holder | succeeds |

A global lock (no `Holder`) blocks every holder-to-holder payment the same way, leaves issuer payments working, and sets `lsfMPTLocked` (`0x01`) on the issuance. When a requirement says a frozen holder "can't send or receive", say which of these payments it covers.

### Claw back

MPT clawback names the holder in the `Holder` field. The issuance needs `tfMPTCanClawback`.

```typescript
await submitOrThrow(client, {
  TransactionType: 'Clawback',
  Account: issuer.address,
  Amount: { mpt_issuance_id: issuanceId, value: toRawUnits('300', assetScale) },
  Holder: holder.address,
}, issuer);
```

### Ban an address

There is no ban transaction. On an issuance with `tfMPTRequireAuth`:

1. Claw back the whole balance, read from the ledger first.
2. Revoke the approval: the issuer sends `MPTokenAuthorize` with `Holder` and `tfMPTUnauthorize`.
3. Add the address to your own deny list and check it before every approval. The ledger keeps no record of the ban, so approving the address again undoes it.

```typescript
import { MPTokenAuthorizeFlags } from 'xrpl';

const state = await readHolder(client, issuanceId, banned);
if (state !== undefined) {
  if (state.rawBalance !== '0') {
    await submitOrThrow(client, {
      TransactionType: 'Clawback',
      Account: issuer.address,
      Amount: { mpt_issuance_id: issuanceId, value: state.rawBalance },
      Holder: banned,
    }, issuer);
  }
  await submitOrThrow(client, {
    TransactionType: 'MPTokenAuthorize',
    Account: issuer.address,
    MPTokenIssuanceID: issuanceId,
    Holder: banned,
    Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
  }, issuer);
}
```

Order matters. Revoking first strands the balance: every payment to or from that holder, including to the issuer, then fails with `tecNO_AUTH`. After the revoke, the holder cannot approve itself again (`tecDUPLICATE`). An address that never opted in has no `MPToken` entry, so there is nothing on the ledger to revoke or lock; the allow-list is the only protection. Without `tfMPTRequireAuth`, a ban cannot be enforced at all.

## xrpl.js 5.x TypeScript notes

These names tripped most agents in testing against `xrpl@5.3.0`:

- **Ledger entry types live under the `LedgerEntry` namespace.** `import { LedgerEntry } from 'xrpl'`, then `LedgerEntry.MPToken`, `LedgerEntry.MPTokenIssuance` and `LedgerEntry.MPTokenIssuanceFlags`. `import { MPToken } from 'xrpl'` does not compile.
- **Transaction flag enums are top-level:** `MPTokenIssuanceCreateFlags`, `MPTokenIssuanceSetFlags` and `MPTokenAuthorizeFlags`. There is no top-level `MPTokenIssuanceFlags`, and no enum for a holder's `MPToken` flags (`lsfMPTLocked` is `0x01`, `lsfMPTAuthorized` is `0x02`).
- **`MPTokenIssuanceCreateMetadata` is not exported.** Type the create transaction as `MPTokenIssuanceCreate`, and `submitAndWait` returns metadata with a typed `mpt_issuance_id`.
- **`ledger_entry` responses are typed as the whole `LedgerEntry` union.** `MPTokenIssuance` narrows on `LedgerEntryType`. `MPToken` is missing from the union, so narrowing to it gives `never`; use a runtime guard over `unknown`, as `readHolder` does, instead of `as unknown as`.
- **`MPTAmount` is typed as a required string,** but rippled omits it when the balance is zero.
- **`submitAndWait` takes a `SubmittableTransaction`.** Type your own helpers with it, or with a specific transaction type. `Transaction` also includes pseudo-transactions and is rejected.

## Anti-patterns

- **Don't pass display amounts as `value` when `AssetScale` is above 0.** Convert with `toRawUnits`.
- **Don't set `TransferFee` without `tfMPTCanTransfer`.**
- **Don't treat a resolved `submitAndWait` as success.** `tecNO_AUTH` and `tecLOCKED` resolve normally; check the result.
- **Don't use trust-line controls on MPTs.** `TrustSet` freeze flags and `AccountSet` `asfGlobalFreeze` do not apply to MPTs.
- **Don't misspell field names.** A lowercase `holder` compiles, is dropped when signing, and turns a one-holder lock into a global lock.
- **Don't revoke a holder's approval before clawing back its balance.**
- **Don't cast ledger responses with `as unknown as`.** Guard them at runtime.
