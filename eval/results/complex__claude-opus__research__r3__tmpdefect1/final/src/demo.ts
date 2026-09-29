/**
 * End-to-end demo of every issuer control against XRPL testnet.
 *
 * Run with: npm run demo   (reads XRPL_WS_URL, ISSUER_ADDRESS and ISSUER_SEED from .env)
 *
 * Final ledger state:
 *   A: approved, 500, frozen then unfrozen (not frozen)
 *   B: approved, sent 1,000, 300 clawed back (700), frozen
 *   C: approved, sent 100, then banned (0, unauthorized, frozen)
 *   Token globally frozen then unfrozen (not frozen)
 *
 * Writes result.json with the issuance ID and holder addresses, and the
 * holders' testnet seeds to demo-holders.secret.json (git-ignored).
 */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

import { Client, ECDSA, Wallet, xrpToDrops } from 'xrpl'

import { InMemoryBanStore } from './banStore.js'
import { ComplianceError, IssuerError, PreconditionError, TransactionFailedError } from './errors.js'
import * as holderActions from './holder.js'
import { type HolderState, type Logger, MptIssuer, REQUIRED_ISSUANCE_FLAGS } from './issuer.js'
import { submitTransaction } from './ledger.js'

const TESTNET_NETWORK_ID = 1
const REQUIRED_AMENDMENTS = ['MPTokensV1', 'Clawback']
const HOLDER_FUNDING_XRP = 5

const logger: Logger = {
  info: (message, fields) => console.log(`    [issuer] ${message}`, fields ?? ''),
  warn: (message, fields) => console.log(`    [issuer] ${message}`, fields ?? ''),
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable ${name} (see .env.example)`)
  }
  return value
}

function step(title: string): void {
  console.log(`\n== ${title}`)
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`)
}

/** Assert that `action` is refused, either by the module or by the ledger itself. */
async function expectRejected(
  description: string,
  action: () => Promise<unknown>,
  expected: { error: new (...args: never[]) => IssuerError; resultCodes?: string[] },
): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (!(error instanceof expected.error)) {
      throw new Error(`${description}: expected ${expected.error.name}, got ${String(error)}`, { cause: error })
    }
    if (error instanceof TransactionFailedError && expected.resultCodes !== undefined) {
      assert.ok(
        expected.resultCodes.includes(error.resultCode),
        `${description}: expected one of ${expected.resultCodes.join(', ')}, got ${error.resultCode}`,
      )
    }
    const detail = error instanceof TransactionFailedError ? `ledger: ${error.resultCode}` : `module: ${error.name}`
    ok(`${description} — rejected (${detail})`)
    return
  }
  throw new Error(`${description}: expected rejection, but it succeeded`)
}

async function main(): Promise<void> {
  const url = requireEnv('XRPL_WS_URL')
  const issuerWallet = Wallet.fromSeed(requireEnv('ISSUER_SEED'), { algorithm: ECDSA.ed25519 })
  assert.equal(issuerWallet.classicAddress, requireEnv('ISSUER_ADDRESS'), 'ISSUER_SEED does not match ISSUER_ADDRESS')

  const client = new Client(url)
  await client.connect()
  try {
    await run(client, issuerWallet)
  } finally {
    await client.disconnect()
  }
}

async function run(client: Client, issuerWallet: Wallet): Promise<void> {
  step('Preflight: network and amendments')
  assert.equal(client.networkID, TESTNET_NETWORK_ID, `Expected testnet (network ${TESTNET_NETWORK_ID}), got ${client.networkID}`)
  const features = (await client.request({ command: 'feature' })).result.features
  for (const name of REQUIRED_AMENDMENTS) {
    const enabled = Object.values(features).some((f) => f.name === name && f.enabled)
    assert.ok(enabled, `Amendment ${name} is not enabled on this network`)
  }
  ok(`connected to testnet; ${REQUIRED_AMENDMENTS.join(', ')} enabled`)

  step('Create the MPT issuance')
  const banStore = new InMemoryBanStore()
  const issuer = await MptIssuer.createIssuance(
    client,
    issuerWallet,
    {
      assetScale: 0,
      metadata: {
        ticker: 'RUSD',
        name: 'Regulated USD (testnet demo)',
        desc: 'Allowlisted, freezable, clawback-enabled stablecoin-style MPT for testnet demonstration only.',
        icon: 'example.com/rusd.png',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Demo Issuer',
      },
    },
    { banStore, logger },
  )
  const issuance = await issuer.getIssuance()
  assert.equal(issuance.flags & REQUIRED_ISSUANCE_FLAGS, REQUIRED_ISSUANCE_FLAGS)
  ok(`issuance ${issuer.issuanceId} (flags 0x${issuance.flags.toString(16)}: RequireAuth, CanLock, CanClawback, CanTransfer)`)

  step('Create and fund holders A, B, C')
  const wallets = {
    A: Wallet.generate(ECDSA.ed25519),
    B: Wallet.generate(ECDSA.ed25519),
    C: Wallet.generate(ECDSA.ed25519),
  }
  await writeFile(
    'demo-holders.secret.json',
    JSON.stringify(
      Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])),
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  for (const [name, wallet] of Object.entries(wallets)) {
    await submitTransaction(client, issuerWallet, {
      TransactionType: 'Payment',
      Account: issuerWallet.classicAddress,
      Destination: wallet.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })
    ok(`${name} = ${wallet.classicAddress} funded with ${HOLDER_FUNDING_XRP} XRP`)
  }
  const { A, B, C } = wallets
  const id = issuer.issuanceId

  step('Holders opt in')
  for (const [name, wallet] of Object.entries(wallets)) {
    await holderActions.optIn(client, wallet, id)
    ok(`${name} opted in (MPToken created, not yet authorized)`)
  }

  step('Allowlist: unapproved holders cannot receive the token')
  await expectRejected('module refuses to issue to unapproved A', () => issuer.issue(A.classicAddress, '500'), {
    error: ComplianceError,
  })
  await expectRejected(
    'ledger rejects a raw issuer payment to unapproved A',
    () => rawIssuerPayment(client, issuerWallet, A.classicAddress, id, 1n),
    { error: TransactionFailedError, resultCodes: ['tecNO_AUTH'] },
  )

  step('Allowlist: approve A, B, C after KYC')
  for (const [name, wallet] of Object.entries(wallets)) {
    await issuer.authorizeHolder(wallet.classicAddress)
    ok(`${name} authorized`)
  }
  assert.equal((await issuer.authorizeHolder(A.classicAddress)).changed, false)
  ok('re-authorizing A is a no-op (idempotent)')

  step('Issue tokens')
  await issuer.issue(A.classicAddress, '500')
  await issuer.issue(B.classicAddress, '1000')
  await issuer.issue(C.classicAddress, '100')
  await expectBalance(issuer, A.classicAddress, '500')
  await expectBalance(issuer, B.classicAddress, '1000')
  await expectBalance(issuer, C.classicAddress, '100')
  ok('A=500, B=1000, C=100')

  step('Per-holder freeze: freeze A')
  await issuer.freezeHolder(A.classicAddress)
  assert.equal((await issuer.getHolder(A.classicAddress)).frozen, true)
  ok('A frozen')
  await expectRejected('frozen A cannot send to B', () => holderActions.transfer(client, A, B.classicAddress, id, 25n), {
    error: TransactionFailedError,
    resultCodes: ['tecLOCKED'],
  })
  await expectRejected('B cannot send to frozen A', () => holderActions.transfer(client, B, A.classicAddress, id, 25n), {
    error: TransactionFailedError,
    resultCodes: ['tecLOCKED'],
  })
  // The ledger does NOT stop the issuer itself paying a locked holder, so
  // this guard in the module is what keeps issuance away from frozen holders.
  await expectRejected('module refuses to issue to frozen A', () => issuer.issue(A.classicAddress, '1'), {
    error: PreconditionError,
  })

  step('Per-holder freeze: unfreeze A')
  await issuer.unfreezeHolder(A.classicAddress)
  assert.equal((await issuer.getHolder(A.classicAddress)).frozen, false)
  await holderActions.transfer(client, A, B.classicAddress, id, 25n)
  await holderActions.transfer(client, B, A.classicAddress, id, 25n)
  await expectBalance(issuer, A.classicAddress, '500')
  ok('A unfrozen; A→B 25 and B→A 25 both succeed (balances unchanged: A=500, B=1000)')

  step('Clawback: claw back 300 from B')
  const clawback = await issuer.clawback(B.classicAddress, '300')
  assert.equal(clawback.clawedBack, '300')
  await expectBalance(issuer, B.classicAddress, '700')
  ok('clawed back 300; B=700')

  step('Global freeze')
  await issuer.freezeAll()
  assert.equal((await issuer.getIssuance()).globallyFrozen, true)
  ok('token globally frozen')
  await expectRejected('A cannot send to B during global freeze', () => holderActions.transfer(client, A, B.classicAddress, id, 10n), {
    error: TransactionFailedError,
    resultCodes: ['tecLOCKED'],
  })
  await expectRejected('module refuses to issue during global freeze', () => issuer.issue(A.classicAddress, '1'), {
    error: PreconditionError,
  })
  await issuer.unfreezeAll()
  assert.equal((await issuer.getIssuance()).globallyFrozen, false)
  await holderActions.transfer(client, A, B.classicAddress, id, 10n)
  await holderActions.transfer(client, B, A.classicAddress, id, 10n)
  ok('global freeze lifted; A→B 10 and B→A 10 both succeed (balances unchanged)')

  step('Ban C')
  const ban = await issuer.ban(C.classicAddress, 'Demo: sanctions screening hit')
  assert.equal(ban.clawedBack, '100')
  const cState = await issuer.getHolder(C.classicAddress)
  assert.deepEqual(pick(cState), { balance: '0', authorized: false, frozen: true, banned: true })
  ok(`C banned: clawed back ${ban.clawedBack}; balance 0, authorization revoked, frozen`)
  await expectRejected('module refuses to re-authorize banned C', () => issuer.authorizeHolder(C.classicAddress), {
    error: ComplianceError,
  })
  await expectRejected('module refuses to issue to banned C', () => issuer.issue(C.classicAddress, '1'), {
    error: ComplianceError,
  })
  await expectRejected(
    'ledger rejects a raw issuer payment to banned C',
    () => rawIssuerPayment(client, issuerWallet, C.classicAddress, id, 1n),
    { error: TransactionFailedError, resultCodes: ['tecNO_AUTH', 'tecLOCKED'] },
  )
  await expectRejected('A cannot send to banned C', () => holderActions.transfer(client, A, C.classicAddress, id, 1n), {
    error: TransactionFailedError,
    resultCodes: ['tecNO_AUTH', 'tecLOCKED'],
  })
  assert.equal((await issuer.ban(C.classicAddress, 'again')).changed, false)
  ok('banning C again is a no-op (idempotent)')

  step('Freeze B (final state)')
  await issuer.freezeHolder(B.classicAddress)
  ok('B frozen')

  step('Verify final ledger state')
  const final = await issuer.getIssuance()
  assert.equal(final.issuer, issuerWallet.classicAddress)
  assert.equal(final.flags & REQUIRED_ISSUANCE_FLAGS, REQUIRED_ISSUANCE_FLAGS)
  assert.equal(final.globallyFrozen, false)
  assert.equal(final.outstandingAmount, '1200')
  const expected = {
    A: { balance: '500', authorized: true, frozen: false, banned: false },
    B: { balance: '700', authorized: true, frozen: true, banned: false },
    C: { balance: '0', authorized: false, frozen: true, banned: true },
  }
  for (const [name, wallet] of Object.entries(wallets)) {
    const state = pick(await issuer.getHolder(wallet.classicAddress))
    assert.deepEqual(state, expected[name as keyof typeof expected], `holder ${name}`)
    ok(`${name}: ${JSON.stringify(state)}`)
  }
  ok(`issuance: outstanding ${final.outstandingAmount}, not globally frozen, all controls enabled`)

  const result = {
    issuanceId: issuer.issuanceId,
    holders: { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress },
  }
  await writeFile('result.json', JSON.stringify(result, null, 2) + '\n')
  console.log('\nWrote result.json:\n' + JSON.stringify(result, null, 2))
}

/** A payment straight from the issuer that bypasses the module's checks, to prove the ledger enforces the rule too. */
function rawIssuerPayment(client: Client, issuerWallet: Wallet, destination: string, issuanceId: string, raw: bigint) {
  return submitTransaction(client, issuerWallet, {
    TransactionType: 'Payment',
    Account: issuerWallet.classicAddress,
    Destination: destination,
    Amount: { mpt_issuance_id: issuanceId, value: raw.toString() },
  })
}

async function expectBalance(issuer: MptIssuer, address: string, balance: string): Promise<void> {
  assert.equal((await issuer.getHolder(address)).balance, balance, `balance of ${address}`)
}

function pick(state: HolderState) {
  return { balance: state.balance, authorized: state.authorized, frozen: state.frozen, banned: state.banned }
}

main().catch((error: unknown) => {
  console.error('\nDemo failed:', error)
  process.exitCode = 1
})
