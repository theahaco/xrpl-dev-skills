/**
 * End-to-end demo of every compliance control against XRPL testnet.
 *
 *   npm run demo                    # issuer = ISSUER_SEED from .env, writes result.json
 *   npm run demo -- --scratch       # issuer = fresh faucet-funded account (dry run), writes state/result.scratch.json
 *
 * Final ledger state:
 *   A: approved, holds 500, frozen then unfrozen (not frozen)
 *   B: approved, sent 1000, 300 clawed back (holds 700), frozen
 *   C: approved, sent 100, then banned (holds 0, not approved, frozen)
 *   Issuance: globally frozen then unfrozen (not frozen)
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Client, type Payment, Wallet, xrpToDrops } from 'xrpl'

import { IssuerError, JsonFileBanRegistry, type Logger, MptIssuer, TransactionSubmitter } from '../src/index.js'

const ROOT = resolve(import.meta.dirname, '..')
const HOLDER_FUNDING_XRP = '5'

const scratch = process.argv.includes('--scratch')

const logger: Logger = {
  info: (message, fields) => console.log(`    · ${message} ${formatFields(fields)}`),
  warn: (message, fields) => console.log(`    ! ${message} ${formatFields(fields)}`),
  error: (message, fields) => console.error(`    ✗ ${message} ${formatFields(fields)}`),
}

function formatFields(fields: Record<string, unknown> = {}): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')
}

function step(title: string): void {
  console.log(`\n▶ ${title}`)
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`)
}

/** A holder's own account, used only to simulate holder behaviour in the demo. */
class DemoHolder {
  readonly name: string
  readonly wallet: Wallet
  private readonly submitter: TransactionSubmitter

  constructor(name: string, client: Client, wallet: Wallet) {
    this.name = name
    this.wallet = wallet
    this.submitter = new TransactionSubmitter(client, wallet, { logger })
  }

  get address(): string {
    return this.wallet.classicAddress
  }

  async optIn(issuanceId: string): Promise<void> {
    await this.submitter.submit({ TransactionType: 'MPTokenAuthorize', Account: this.address, MPTokenIssuanceID: issuanceId })
  }

  /** Attempts a holder-to-holder transfer and returns the validated result code. */
  async trySend(issuanceId: string, to: DemoHolder, value: string): Promise<string> {
    const result = await this.submitter.submitAllowingFailure(mptPayment(this.address, to.address, issuanceId, value))
    return result.resultCode
  }
}

function mptPayment(from: string, to: string, issuanceId: string, value: string): Payment {
  return { TransactionType: 'Payment', Account: from, Destination: to, Amount: { mpt_issuance_id: issuanceId, value } }
}

function expectCode(actual: string, expected: readonly string[], what: string): void {
  assert.ok(expected.includes(actual), `${what}: expected ${expected.join(' or ')}, got ${actual}`)
  ok(`${what} → rejected by the ledger with ${actual}`)
}

async function expectIssuerError(promise: Promise<unknown>, code: IssuerError['code'], what: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof IssuerError && error.code === code, what)
  ok(`${what} → refused by the issuer module (${code})`)
}

async function loadIssuerWallet(client: Client): Promise<Wallet> {
  if (scratch) {
    const { wallet } = await client.fundWallet()
    return wallet
  }
  const seed = process.env.ISSUER_SEED
  if (seed === undefined || seed === '') throw new Error('ISSUER_SEED is not set (see .env.example)')
  const wallet = Wallet.fromSeed(seed)
  const expected = process.env.ISSUER_ADDRESS
  if (expected !== undefined && expected !== '' && expected !== wallet.classicAddress) {
    throw new Error(`ISSUER_SEED derives ${wallet.classicAddress}, but ISSUER_ADDRESS is ${expected}`)
  }
  return wallet
}

async function main(): Promise<void> {
  if (existsSync(resolve(ROOT, '.env'))) process.loadEnvFile(resolve(ROOT, '.env'))
  const client = new Client(process.env.XRPL_WS_URL ?? 'wss://s.altnet.rippletest.net:51233')
  await client.connect()
  try {
    await run(client)
  } finally {
    await client.disconnect()
  }
}

async function run(client: Client): Promise<void> {
  const stateDir = resolve(ROOT, 'state')
  await mkdir(stateDir, { recursive: true })

  step(`Loading issuer (${scratch ? 'scratch faucet account' : 'ISSUER_SEED'})`)
  const issuerWallet = await loadIssuerWallet(client)
  const issuerFunds = new TransactionSubmitter(client, issuerWallet, { logger })
  ok(`issuer ${issuerWallet.classicAddress}, balance ${await client.getXrpBalance(issuerWallet.classicAddress)} XRP`)

  step(`Creating holder accounts A, B, C (funded with ${HOLDER_FUNDING_XRP} XRP each from the issuer)`)
  const holders = { A: Wallet.generate(), B: Wallet.generate(), C: Wallet.generate() }
  // Persist holder keys before funding them so no funded key is ever lost.
  const secretsDir = resolve(ROOT, '.secrets')
  await mkdir(secretsDir, { recursive: true, mode: 0o700 })
  await writeFile(
    resolve(secretsDir, `holders-${issuerWallet.classicAddress}-${Date.now()}.json`),
    `${JSON.stringify(Object.fromEntries(Object.entries(holders).map(([name, w]) => [name, { address: w.classicAddress, seed: w.seed }])), null, 2)}\n`,
    { mode: 0o600 },
  )
  for (const wallet of Object.values(holders)) {
    await issuerFunds.submit({ TransactionType: 'Payment', Account: issuerWallet.classicAddress, Destination: wallet.classicAddress, Amount: xrpToDrops(HOLDER_FUNDING_XRP) })
  }
  const A = new DemoHolder('A', client, holders.A)
  const B = new DemoHolder('B', client, holders.B)
  const C = new DemoHolder('C', client, holders.C)
  for (const h of [A, B, C]) ok(`holder ${h.name}: ${h.address}`)

  step('Creating the MPT issuance (allowlist + clawback + freeze controls)')
  const issuer = await MptIssuer.createIssuance(
    client,
    issuerWallet,
    {
      assetScale: 0,
      transferable: true,
      metadata: {
        ticker: 'DUSD',
        name: 'Demo Regulated Dollar (testnet)',
        desc: 'Testnet demonstration of a compliance-controlled stablecoin-style MPT.',
        icon: 'https://example.com/dusd.png',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Demo Issuer',
      },
    },
    { banRegistry: new JsonFileBanRegistry(resolve(stateDir, scratch ? 'ban-registry.scratch.json' : 'ban-registry.json')), logger },
  )
  const id = issuer.issuanceId
  const issuance = await issuer.getIssuanceState()
  assert.deepEqual(
    { ...issuance.capabilities },
    { canLock: true, requireAuth: true, canTransfer: true, canClawback: true, canEscrow: false, canTrade: false, canHoldConfidentialBalance: false },
  )
  ok(`issuance ${id}`)

  step('Allowlist: holders opt in; nothing moves until the issuer approves them')
  for (const h of [A, B, C]) await h.optIn(id)
  await expectIssuerError(issuer.issue(A.address, '1'), 'HOLDER_NOT_AUTHORIZED', 'issue to A before approval (module)')
  const unapproved = await issuerFunds.submitAllowingFailure(mptPayment(issuerWallet.classicAddress, A.address, id, '1'))
  expectCode(unapproved.resultCode, ['tecNO_AUTH'], 'raw issuer payment to unapproved A (ledger)')
  for (const h of [A, B, C]) await issuer.authorizeHolder(h.address)
  ok('A, B and C approved after (simulated) KYC')

  step('Issuing: A 400, B 1000, C 150; C sends 50 to A (approved holders can transfer)')
  await issuer.issue(A.address, '400')
  await issuer.issue(B.address, '1000')
  await issuer.issue(C.address, '150')
  assert.equal(await C.trySend(id, A, '50'), 'tesSUCCESS', 'C → A 50')
  ok('balances: A 450, B 1000, C 100')

  step('Clawback: 300 from B')
  const clawed = await issuer.clawback(B.address, '300')
  assert.equal(clawed.amount, '300')
  assert.equal(clawed.holderBalance, '700')
  await expectIssuerError(issuer.clawback(B.address, '701'), 'INSUFFICIENT_BALANCE', 'claw back more than B holds')
  ok('B now holds 700')

  step('Per-holder freeze: freeze A, confirm A can neither send nor receive, then unfreeze')
  await issuer.freezeHolder(A.address)
  assert.equal((await issuer.getHolderState(A.address)).frozen, true)
  expectCode(await A.trySend(id, B, '1'), ['tecLOCKED'], 'frozen A sends to B')
  expectCode(await B.trySend(id, A, '1'), ['tecLOCKED'], 'B sends to frozen A')
  await expectIssuerError(issuer.issue(A.address, '1'), 'HOLDER_FROZEN', 'issue to frozen A')
  await issuer.unfreezeHolder(A.address)
  assert.equal((await issuer.getHolderState(A.address)).frozen, false)
  await issuer.issue(A.address, '50')
  ok('A unfrozen and received 50 → holds 500')

  step('Global freeze: freeze the whole token, confirm nothing moves, then lift it')
  await issuer.freezeAll()
  assert.equal((await issuer.getIssuanceState()).globallyFrozen, true)
  expectCode(await B.trySend(id, C, '1'), ['tecLOCKED'], 'B sends to C during global freeze')
  expectCode(await A.trySend(id, B, '1'), ['tecLOCKED'], 'A sends to B during global freeze')
  await expectIssuerError(issuer.issue(C.address, '1'), 'TOKEN_FROZEN', 'issue to C during global freeze')
  await issuer.unfreezeAll()
  assert.equal((await issuer.getIssuanceState()).globallyFrozen, false)
  ok('global freeze lifted')

  step('Ban: ban C (claw back everything, remove from allowlist, freeze position)')
  const ban = await issuer.banHolder(C.address, 'Demo: sanctions screening match')
  assert.equal(ban.clawedBack, '100')
  ok(`C banned; clawed back ${ban.clawedBack} in ${ban.txHashes.length} transactions`)
  await expectIssuerError(issuer.issue(C.address, '1'), 'HOLDER_BANNED', 'issue to banned C')
  await expectIssuerError(issuer.authorizeHolder(C.address), 'HOLDER_BANNED', 're-approve banned C')
  expectCode(await A.trySend(id, C, '1'), ['tecNO_AUTH', 'tecLOCKED'], 'A sends to banned C')
  expectCode((await issuerFunds.submitAllowingFailure(mptPayment(issuerWallet.classicAddress, C.address, id, '1'))).resultCode, ['tecNO_AUTH', 'tecLOCKED'], 'raw issuer payment to banned C, bypassing the module')

  step('Freezing B (final state)')
  await issuer.freezeHolder(B.address)

  step('Verifying final ledger state')
  const final = await issuer.getIssuanceState()
  const [a, b, c] = await Promise.all([A, B, C].map((h) => issuer.getHolderState(h.address)))
  assert.ok(a !== undefined && b !== undefined && c !== undefined)
  assert.equal(final.issuer, issuerWallet.classicAddress)
  assert.equal(final.globallyFrozen, false)
  assert.equal(final.outstanding, '1200')
  assert.deepEqual([a.authorized, a.balance, a.frozen, a.ban], [true, '500', false, undefined])
  assert.deepEqual([b.authorized, b.balance, b.frozen, b.ban], [true, '700', true, undefined])
  assert.deepEqual([c.authorized, c.balance, c.lockedAmount, c.frozen, c.ban !== undefined], [false, '0', '0', true, true])
  console.log(JSON.stringify({ issuance: final, holders: { A: a, B: b, C: c } }, null, 2))

  const result = { issuanceId: id, holders: { A: A.address, B: B.address, C: C.address } }
  const resultPath = scratch ? resolve(stateDir, 'result.scratch.json') : resolve(ROOT, 'result.json')
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  ok(`wrote ${resultPath}`)
}

main().catch((error: unknown) => {
  console.error('\nDemo failed:', error)
  process.exitCode = 1
})
