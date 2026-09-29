/**
 * End-to-end demo against XRPL testnet. Exercises every compliance control
 * and asserts the ledger state after each step. Each negative check submits
 * directly to the ledger where it can, bypassing this module, to show the
 * ledger itself enforces the control.
 *
 * Usage: ISSUER_SEED=... npm run demo   (or put it in .env)
 */
import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Client, Wallet, xrpToDrops } from 'xrpl'

import {
  type AuditLogger,
  FileBanRegistry,
  LedgerStateError,
  MptIssuer,
  PolicyViolationError,
  TransactionFailedError,
  optIn,
  submitAndConfirm,
  transfer,
} from '../src/index.js'

const WS_URL = process.env.XRPL_WS_URL ?? 'wss://s.altnet.rippletest.net:51233'
const HOLDER_FUNDING_XRP = '5'
const ROOT = join(import.meta.dirname, '..')

const logger: AuditLogger = {
  info: (event, fields) => console.log(`  [audit] ${event}`, JSON.stringify(fields, bigintJson)),
  warn: (event, fields) => console.log(`  [audit!] ${event}`, JSON.stringify(fields, bigintJson)),
}

function bigintJson(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value
}

function step(title: string) {
  console.log(`\n== ${title}`)
}

/** Assert that `fn` fails with a ledger result code in `codes`, or with the given module error class. */
async function expectRejected(
  what: string,
  fn: () => Promise<unknown>,
  expected: string[] | (new (...args: never[]) => Error),
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (Array.isArray(expected)) {
      assert(err instanceof TransactionFailedError, `${what}: expected a ledger failure, got ${String(err)}`)
      assert(expected.includes(err.resultCode), `${what}: expected ${expected.join('|')}, got ${err.resultCode}`)
      console.log(`  ✓ ${what} -> rejected by ledger with ${err.resultCode} (${err.hash})`)
    } else {
      assert(err instanceof expected, `${what}: expected ${expected.name}, got ${String(err)}`)
      console.log(`  ✓ ${what} -> refused by module: ${err.message}`)
    }
    return
  }
  assert.fail(`${what}: expected rejection but it succeeded`)
}

async function main() {
  const seed = process.env.ISSUER_SEED
  if (!seed) throw new Error('ISSUER_SEED is not set (see .env.example)')
  const issuerWallet = Wallet.fromSeed(seed)

  const client = new Client(WS_URL)
  await client.connect()
  try {
    await run(client, issuerWallet)
  } finally {
    await client.disconnect()
  }
}

async function run(client: Client, issuerWallet: Wallet) {
  console.log(`Issuer: ${issuerWallet.classicAddress} on ${WS_URL}`)
  console.log(`Issuer XRP balance: ${await client.getXrpBalance(issuerWallet.classicAddress)}`)

  // ---------------------------------------------------------------- issuance
  step('Create issuance (RequireAuth + CanLock + CanClawback + CanTransfer)')
  const { issuanceId } = await MptIssuer.createIssuance(client, issuerWallet, {
    assetScale: 0,
    canTransfer: true,
    metadata: {
      ticker: 'DUSD',
      name: 'Demo Regulated USD',
      desc: 'Testnet demo of a compliance-controlled stablecoin issued as an MPT.',
      icon: 'https://example.com/dusd.png',
      asset_class: 'rwa',
      asset_subclass: 'stablecoin',
      issuer_name: 'Demo Issuer (testnet)',
    },
  })
  console.log(`  issuanceId: ${issuanceId}`)

  const issuer = await MptIssuer.open({
    client,
    issuerWallet,
    issuanceId,
    banRegistry: new FileBanRegistry(join(ROOT, 'data', issuanceId, 'bans.json')),
    logger,
  })
  const iss = await issuer.getIssuanceState()
  assert(iss.flags.requireAuth && iss.flags.canLock && iss.flags.canClawback && iss.flags.canTransfer)
  assert(!iss.flags.canEscrow && !iss.flags.canTrade && !iss.flags.canHoldConfidentialBalance)
  console.log('  ✓ on-ledger flags:', JSON.stringify(iss.flags))

  // ----------------------------------------------------------------- holders
  step(`Create and fund holders A, B, C (${HOLDER_FUNDING_XRP} XRP each, from the issuer)`)
  const holders = { A: Wallet.generate(), B: Wallet.generate(), C: Wallet.generate() }
  await writeFile(
    join(ROOT, '.demo-holders.json'),
    JSON.stringify(
      { issuanceId, holders: Object.fromEntries(Object.entries(holders).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])) },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  for (const [name, w] of Object.entries(holders)) {
    await submitAndConfirm(client, issuerWallet, {
      TransactionType: 'Payment',
      Account: issuerWallet.classicAddress,
      Destination: w.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })
    console.log(`  ${name}: ${w.classicAddress}`)
  }
  const { A, B, C } = holders
  const a = A.classicAddress
  const b = B.classicAddress
  const c = C.classicAddress

  // --------------------------------------------------------------- allowlist
  step('Allowlist: holders opt in; unapproved holders cannot receive')
  for (const w of [A, B, C]) await optIn(client, w, issuanceId)
  await expectRejected('issuer pays unapproved C directly on ledger', () => transfer(client, issuerWallet, c, issuanceId, 1n), ['tecNO_AUTH'])
  await expectRejected('module issue() to unapproved C', () => issuer.issue(c, 1n), LedgerStateError)

  step('Allowlist: approve A, B, C after KYC and issue tokens')
  for (const h of [a, b, c]) await issuer.authorizeHolder(h)
  await issuer.issue(a, 400n)
  await issuer.issue(b, 1000n)
  await issuer.issue(c, 250n)
  assert.equal((await issuer.getHolderState(a)).balance, 400n)
  assert.equal((await issuer.getHolderState(b)).balance, 1000n)
  assert.equal((await issuer.getHolderState(c)).balance, 250n)
  console.log('  ✓ A=400, B=1000, C=250')

  // -------------------------------------------------------- per-holder freeze
  step('Per-holder freeze: freeze A')
  await issuer.freezeHolder(a)
  assert((await issuer.getHolderState(a)).frozen)
  // The ledger's lock does not cover issuer payments, so the module enforces this leg.
  await expectRejected('module issue() to frozen A', () => issuer.issue(a, 100n), PolicyViolationError)
  await expectRejected('B sends to frozen A', () => transfer(client, B, a, issuanceId, 10n), ['tecLOCKED'])
  await expectRejected('frozen A sends to B', () => transfer(client, A, b, issuanceId, 10n), ['tecLOCKED'])
  assert.equal((await issuer.getHolderState(a)).balance, 400n)

  step('Per-holder freeze: unfreeze A, then A can receive again')
  await issuer.unfreezeHolder(a)
  assert(!(await issuer.getHolderState(a)).frozen)
  await issuer.issue(a, 100n)
  assert.equal((await issuer.getHolderState(a)).balance, 500n)
  console.log('  ✓ A unfrozen and holds 500')

  // ---------------------------------------------------------------- clawback
  step('Clawback: claw back 300 from B')
  await expectRejected('claw back more than B holds', () => issuer.clawback(b, 1001n), LedgerStateError)
  await issuer.clawback(b, 300n)
  assert.equal((await issuer.getHolderState(b)).balance, 700n)
  console.log('  ✓ B holds 700')

  // ----------------------------------------------------------- global freeze
  step('Global freeze: freeze all movement of the token')
  await issuer.freezeAll()
  assert((await issuer.getIssuanceState()).globallyFrozen)
  await expectRejected('B sends to A during global freeze', () => transfer(client, B, a, issuanceId, 50n), ['tecLOCKED'])
  await expectRejected('A sends to B during global freeze', () => transfer(client, A, b, issuanceId, 50n), ['tecLOCKED'])
  await expectRejected('module issue() to A during global freeze', () => issuer.issue(a, 1n), PolicyViolationError)

  step('Global freeze: lift it, then holders can transfer again')
  await issuer.unfreezeAll()
  assert(!(await issuer.getIssuanceState()).globallyFrozen)
  await transfer(client, B, a, issuanceId, 50n)
  await transfer(client, A, b, issuanceId, 50n)
  assert.equal((await issuer.getHolderState(a)).balance, 500n)
  assert.equal((await issuer.getHolderState(b)).balance, 700n)
  console.log('  ✓ B->A 50 and A->B 50 succeeded; balances back to A=500, B=700')

  // -------------------------------------------------------------------- ban
  step('Ban C')
  const ban = await issuer.ban(c, 'Demo: sanctions screening match')
  assert.equal(ban.clawedBack, 250n)
  const cState = await issuer.getHolderState(c)
  assert(cState.banned && !cState.authorized && cState.balance === 0n)
  console.log(`  ✓ C banned: clawed back ${ban.clawedBack}, balance 0, authorization revoked, frozen=${cState.frozen}`)
  await expectRejected('issuer pays banned C directly on ledger', () => transfer(client, issuerWallet, c, issuanceId, 1n), ['tecNO_AUTH'])
  await expectRejected('A sends to banned C', () => transfer(client, A, c, issuanceId, 1n), ['tecNO_AUTH', 'tecLOCKED'])
  await expectRejected('module re-authorizes banned C', () => issuer.authorizeHolder(c), PolicyViolationError)
  await expectRejected('module issues to banned C', () => issuer.issue(c, 1n), PolicyViolationError)
  await expectRejected('module unfreezes banned C', () => issuer.unfreezeHolder(c), PolicyViolationError)
  const reban = await issuer.ban(c, 'duplicate')
  assert.equal(reban.receipts.length, 0)
  console.log('  ✓ re-banning C is a no-op')

  // --------------------------------------------------------- final: freeze B
  step('Freeze B (stays frozen)')
  await issuer.freezeHolder(b)
  await expectRejected('frozen B sends to A', () => transfer(client, B, a, issuanceId, 1n), ['tecLOCKED'])

  // ------------------------------------------------------------ final state
  step('Verify final ledger state')
  const [fa, fb, fc, fi] = await Promise.all([
    issuer.getHolderState(a),
    issuer.getHolderState(b),
    issuer.getHolderState(c),
    issuer.getIssuanceState(),
  ])
  assert(fa.authorized && !fa.frozen && fa.balance === 500n, 'A final state')
  assert(fb.authorized && fb.frozen && fb.balance === 700n, 'B final state')
  assert(!fc.authorized && fc.balance === 0n && fc.banned, 'C final state')
  assert(!fi.globallyFrozen, 'issuance not globally frozen')
  assert.equal(fi.outstandingAmount, 1200n)
  for (const s of [fa, fb, fc]) {
    console.log(`  ${s.address}: balance=${s.balance} authorized=${s.authorized} frozen=${s.frozen} banned=${s.banned}`)
  }
  console.log(`  issuance: outstanding=${fi.outstandingAmount} globallyFrozen=${fi.globallyFrozen}`)

  const result = { issuanceId, holders: { A: a, B: b, C: c } }
  await writeFile(join(ROOT, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log('\nWrote result.json:', JSON.stringify(result, null, 2))
}

main().catch((err: unknown) => {
  console.error('\nDEMO FAILED:', err)
  process.exitCode = 1
})
