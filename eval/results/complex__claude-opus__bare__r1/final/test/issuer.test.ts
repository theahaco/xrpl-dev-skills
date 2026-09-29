import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { type Client, Wallet } from 'xrpl'
import {
  type AuditEvent,
  ComplianceViolationError,
  InMemoryBanRegistry,
  InvalidInputError,
  MptIssuer,
  NetworkMismatchError,
} from '../src/index.js'

const issuerWallet = Wallet.generate()
const holder = Wallet.generate().classicAddress
const ISSUANCE_ID = '0000000100000000000000000000000000000000000000AA'

interface FakeLedger {
  issuanceFlags: number
  outstanding: string
  maximum?: string
  holderFlags?: number
  holderBalance?: string
}

/** A fake client that answers ledger reads and fails the test on any submission. */
function fakeClient(ledger: FakeLedger, networkId = 1) {
  const submitted: unknown[] = []
  const client = {
    async request(req: Record<string, unknown>) {
      if (req.command === 'server_info') return { result: { info: { network_id: networkId } } }
      if (req.command === 'ledger_entry') {
        if (req.mpt_issuance) {
          return {
            result: {
              node: {
                LedgerEntryType: 'MPTokenIssuance',
                Issuer: issuerWallet.classicAddress,
                Flags: ledger.issuanceFlags,
                AssetScale: 2,
                OutstandingAmount: ledger.outstanding,
                ...(ledger.maximum ? { MaximumAmount: ledger.maximum } : {}),
              },
            },
          }
        }
        if (ledger.holderFlags === undefined) throw Object.assign(new Error('nf'), { data: { error: 'entryNotFound' } })
        return {
          result: {
            node: {
              LedgerEntryType: 'MPToken',
              Flags: ledger.holderFlags,
              ...(ledger.holderBalance ? { MPTAmount: ledger.holderBalance } : {}),
            },
          },
        }
      }
      throw new Error(`unexpected request ${String(req.command)}`)
    },
    async autofill(tx: unknown) {
      submitted.push(tx)
      throw new Error('submission attempted')
    },
  }
  return { client: client as unknown as Client, submitted }
}

// lock | require-auth | transfer | clawback
const GOOD_FLAGS = 0x02 | 0x04 | 0x20 | 0x40
const AUTHORIZED = 0x02
const LOCKED = 0x01

async function setup(ledger: FakeLedger, bans = new InMemoryBanRegistry()) {
  const { client, submitted } = fakeClient(ledger)
  const events: AuditEvent[] = []
  const issuer = await MptIssuer.load(
    { client, signer: issuerWallet, banRegistry: bans, expectedNetworkId: 1, audit: (e) => void events.push(e) },
    ISSUANCE_ID,
  )
  return { issuer, submitted, events, bans }
}

async function refused(p: Promise<unknown>, code: ComplianceViolationError['code']) {
  await assert.rejects(p, (e: unknown) => e instanceof ComplianceViolationError && e.code === code)
}

test('load() rejects issuances missing controls or allowing escrow/trading', async () => {
  for (const flags of [GOOD_FLAGS & ~0x40, GOOD_FLAGS & ~0x04, GOOD_FLAGS & ~0x02, GOOD_FLAGS | 0x08, GOOD_FLAGS | 0x10]) {
    await assert.rejects(setup({ issuanceFlags: flags, outstanding: '0' }), InvalidInputError)
  }
})

test('load() refuses the wrong network', async () => {
  const { client } = fakeClient({ issuanceFlags: GOOD_FLAGS, outstanding: '0' }, 0)
  await assert.rejects(
    MptIssuer.load({ client, signer: issuerWallet, banRegistry: new InMemoryBanRegistry(), expectedNetworkId: 1 }, ISSUANCE_ID),
    NetworkMismatchError,
  )
})

test('issue() refuses holders that are not opted in, not approved, frozen or banned, and global freezes', async () => {
  await refused((await setup({ issuanceFlags: GOOD_FLAGS, outstanding: '0' })).issuer.issue(holder, '1'), 'HOLDER_NOT_OPTED_IN')
  await refused(
    (await setup({ issuanceFlags: GOOD_FLAGS, outstanding: '0', holderFlags: 0 })).issuer.issue(holder, '1'),
    'HOLDER_NOT_AUTHORIZED',
  )
  await refused(
    (await setup({ issuanceFlags: GOOD_FLAGS, outstanding: '0', holderFlags: AUTHORIZED | LOCKED })).issuer.issue(holder, '1'),
    'HOLDER_FROZEN',
  )
  await refused(
    (await setup({ issuanceFlags: GOOD_FLAGS | LOCKED, outstanding: '0', holderFlags: AUTHORIZED })).issuer.issue(holder, '1'),
    'GLOBALLY_FROZEN',
  )
  await refused(
    (await setup({ issuanceFlags: GOOD_FLAGS, outstanding: '900', maximum: '1000', holderFlags: AUTHORIZED })).issuer.issue(
      holder,
      '1.01',
    ),
    'MAXIMUM_AMOUNT_EXCEEDED',
  )
  const bans = new InMemoryBanRegistry()
  await bans.add({ address: holder, reason: 'x', bannedAt: new Date().toISOString() })
  const { issuer, submitted, events } = await setup({ issuanceFlags: GOOD_FLAGS, outstanding: '0', holderFlags: AUTHORIZED }, bans)
  await refused(issuer.issue(holder, '1'), 'HOLDER_BANNED')
  await refused(issuer.approveHolder(holder), 'HOLDER_BANNED')
  await refused(issuer.unfreezeHolder(holder, 'appeal'), 'HOLDER_BANNED')
  assert.equal(submitted.length, 0)
  assert.deepEqual(
    events.map((e) => [e.action, e.outcome]),
    [
      ['issue', 'refused'],
      ['approve_holder', 'refused'],
      ['unfreeze_holder', 'refused'],
    ],
  )
})

test('issue() and clawback() validate amounts against AssetScale and balance', async () => {
  const { issuer, submitted } = await setup({
    issuanceFlags: GOOD_FLAGS,
    outstanding: '0',
    holderFlags: AUTHORIZED,
    holderBalance: '1000',
  })
  await assert.rejects(issuer.issue(holder, '1.001'), InvalidInputError)
  await assert.rejects(issuer.issue(holder, '0'), InvalidInputError)
  await refused(issuer.clawback(holder, '10.01', 'r'), 'INSUFFICIENT_BALANCE')
  await assert.rejects(issuer.clawback(holder, '1', ''), InvalidInputError)
  assert.equal(submitted.length, 0)
})

test('actions reject invalid addresses and the issuer itself', async () => {
  const { issuer } = await setup({ issuanceFlags: GOOD_FLAGS, outstanding: '0' })
  await assert.rejects(issuer.issue('not-an-address', '1'), InvalidInputError)
  await assert.rejects(issuer.freezeHolder(issuerWallet.classicAddress, 'r'), InvalidInputError)
})

test('idempotent actions are no-ops when already in the requested state', async () => {
  const frozen = await setup({ issuanceFlags: GOOD_FLAGS | LOCKED, outstanding: '0', holderFlags: AUTHORIZED | LOCKED })
  assert.equal(await frozen.issuer.freezeHolder(holder, 'r'), undefined)
  assert.equal(await frozen.issuer.freezeAll('r'), undefined)
  assert.equal(await frozen.issuer.approveHolder(holder), undefined)
  const clear = await setup({ issuanceFlags: GOOD_FLAGS, outstanding: '0', holderFlags: 0 })
  assert.equal(await clear.issuer.unfreezeHolder(holder, 'r'), undefined)
  assert.equal(await clear.issuer.unfreezeAll('r'), undefined)
  assert.equal(await clear.issuer.revokeHolder(holder, 'r'), undefined)
  assert.equal(frozen.submitted.length + clear.submitted.length, 0)
})

test('ban() of an address that never opted in only records it', async () => {
  const { issuer, submitted, bans } = await setup({ issuanceFlags: GOOD_FLAGS, outstanding: '0' })
  const result = await issuer.ban(holder, 'sanctions')
  assert.deepEqual(result.transactions, [])
  assert.equal((await bans.get(holder))?.reason, 'sanctions')
  assert.equal(submitted.length, 0)
})
