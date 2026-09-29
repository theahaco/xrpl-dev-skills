/**
 * End-to-end demo of every compliance control, run against the XRPL testnet.
 *
 *   ISSUER_SEED=sEd... npm run demo
 *
 * Environment variables:
 *   ISSUER_SEED     issuer account seed (required unless --faucet-issuer)
 *   ISSUER_ADDRESS  optional; the demo aborts if the seed derives a different address
 *   XRPL_WS         WebSocket URL (default wss://s.altnet.rippletest.net:51233)
 *   STATE_DIR       where holder secrets and the ban registry go (default .state)
 *
 * Flags:
 *   --faucet-issuer  use a fresh faucet-funded issuer instead of ISSUER_SEED (rehearsal)
 *   --result <path>  where to write the result file (default result.json)
 *   --force          run even though STATE_DIR records a completed run
 *
 * Final state:
 *   A: approved, holds 500, was frozen and unfrozen (not frozen)
 *   B: approved, received 1000, 300 clawed back (holds 700), frozen
 *   C: approved, received 250, then banned (holds 0, unauthorized, frozen)
 *   The token was globally frozen and unfrozen (not globally frozen)
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { Client, ECDSA, MPTokenAuthorizeFlags, Wallet, xrpToDrops } from 'xrpl'
import type { MPTokenAuthorize, Payment, SubmittableTransaction } from 'xrpl'

import { FileBanRegistry } from './banRegistry.js'
import { ComplianceError, MptIssuer } from './issuer.js'
import type { AuditEvent, HolderState } from './issuer.js'
import { submitAndConfirm } from './submit.js'

const TESTNET_WS = 'wss://s.altnet.rippletest.net:51233'
const TESTNET_NETWORK_ID = 1
const REQUIRED_AMENDMENTS = ['MPTokensV1', 'Clawback']
/** XRP sent to each new holder: 1 XRP base reserve + 0.2 per MPToken + fees, with margin. */
const HOLDER_FUNDING_XRP = '3'

const { values: args } = parseArgs({
  options: {
    'faucet-issuer': { type: 'boolean', default: false },
    result: { type: 'string', default: 'result.json' },
    force: { type: 'boolean', default: false },
  },
})

const stateDir = resolve(process.env.STATE_DIR ?? '.state')
const resultPath = resolve(args.result)

type HolderName = 'A' | 'B' | 'C'
const HOLDER_NAMES: readonly HolderName[] = ['A', 'B', 'C']

interface DemoState {
  network: string
  issuer: string
  holders: Record<HolderName, { address: string; seed: string }>
  issuanceId?: string
  completedAt?: string
}

async function main(): Promise<void> {
  const client = new Client(process.env.XRPL_WS ?? TESTNET_WS)
  await client.connect()
  try {
    await run(client)
  } finally {
    await client.disconnect()
  }
}

async function run(client: Client): Promise<void> {
  step('Pre-flight checks')
  await assertTestnet(client)

  const statePath = join(stateDir, 'demo-state.json')
  if (existsSync(statePath) && !args.force) {
    const previous = JSON.parse(await readFile(statePath, 'utf8')) as DemoState
    throw new Error(
      `${statePath} records an earlier run (issuance ${previous.issuanceId ?? 'not created'}, ` +
        `completed ${previous.completedAt ?? 'no'}). Pass --force to start a new run.`,
    )
  }

  const issuerWallet = await loadIssuer(client)
  log(`issuer ${issuerWallet.classicAddress}`)
  log(`issuer balance ${await client.getXrpBalance(issuerWallet.classicAddress)} XRP`)

  // Generate holder wallets and persist their secrets before funding them, so
  // the funded accounts are never lost.
  const holderWallets = Object.fromEntries(
    HOLDER_NAMES.map((name) => [name, Wallet.generate(ECDSA.ed25519)]),
  ) as Record<HolderName, Wallet>
  const state: DemoState = {
    network: client.url,
    issuer: issuerWallet.classicAddress,
    holders: Object.fromEntries(
      HOLDER_NAMES.map((n) => [n, { address: holderWallets[n].classicAddress, seed: holderWallets[n].seed! }]),
    ) as DemoState['holders'],
  }
  await saveJson(statePath, state)
  const addr = (n: HolderName): string => holderWallets[n].classicAddress

  step('Funding holder accounts from the issuer')
  for (const name of HOLDER_NAMES) {
    const tx: Payment = {
      TransactionType: 'Payment',
      Account: issuerWallet.classicAddress,
      Destination: addr(name),
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    }
    const result = await submitAndConfirm(client, issuerWallet, tx)
    log(`${name} ${addr(name)} funded with ${HOLDER_FUNDING_XRP} XRP (${result.hash})`)
  }

  step('Creating the MPT issuance')
  const banRegistry = new FileBanRegistry(join(stateDir, 'bans.json'))
  const issuer = await MptIssuer.create(
    { client, wallet: issuerWallet, banRegistry, onAudit: auditLog },
    {
      // Scale 0 keeps on-ledger amounts identical to display amounts in this
      // demo. A production stablecoin would typically use 2 or 6.
      assetScale: 0,
      transferable: true,
      metadata: {
        ticker: 'RUSD',
        name: 'Regulated USD (testnet demo)',
        desc: 'Testnet demonstration of an allowlisted, freezable, clawback-enabled stablecoin-style MPT.',
        icon: 'example.com/rusd.png',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Example Issuer (testnet)',
      },
    },
    { reference: 'demo-setup' },
  )
  state.issuanceId = issuer.issuanceId
  await saveJson(statePath, state)
  const issuance = await issuer.getIssuance()
  log(`issuance ${issuer.issuanceId}`)
  log(
    `flags: requireAuth=${issuance.requireAuth} canLock=${issuance.canLock} canClawback=${issuance.canClawback} ` +
      `canTransfer=${issuance.canTransfer} canEscrow=${issuance.canEscrow} canTrade=${issuance.canTrade}`,
  )
  check(issuance.requireAuth && issuance.canLock && issuance.canClawback, 'issuance has every compliance control')

  const mpt = (value: string) => ({ mpt_issuance_id: issuer.issuanceId, value })
  const pay = (from: string, to: string, value: string): Payment => ({
    TransactionType: 'Payment',
    Account: from,
    Destination: to,
    Amount: mpt(value),
  })
  const issuerAddr = issuerWallet.classicAddress

  step('Holders opt in to the token (MPTokenAuthorize from each holder)')
  for (const name of HOLDER_NAMES) {
    const tx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: addr(name),
      MPTokenIssuanceID: issuer.issuanceId,
    }
    const result = await submitAndConfirm(client, holderWallets[name], tx)
    log(`${name} opted in (${result.hash})`)
  }

  step('Allowlist: holders that have not passed KYC cannot receive the token')
  await expectRejected(() => issuer.issue(addr('A'), '500'), 'module refuses to issue to unapproved A')
  await expectLedgerRejects(client, pay(issuerAddr, addr('A'), '500'), 'tecNO_AUTH', 'ledger rejects payment to unapproved A')

  step('Allowlist: approving A, B and C after KYC')
  for (const name of HOLDER_NAMES) {
    await issuer.authorizeHolder(addr(name), { reference: `kyc-${name}` })
    check((await issuer.getHolder(addr(name))).authorized, `${name} is on the allowlist`)
  }

  step('Issuing tokens')
  await issuer.issue(addr('A'), '500', { reference: 'demo-issue-A' })
  await issuer.issue(addr('B'), '1000', { reference: 'demo-issue-B' })
  await issuer.issue(addr('C'), '250', { reference: 'demo-issue-C' })
  await expectBalances(issuer, { A: '500', B: '1000', C: '250' }, addr)
  await expectLedgerAccepts(client, pay(addr('A'), addr('B'), '1'), 'approved holders can pay each other (A → B)')

  step('Clawback: recovering 300 from B')
  const { clawedBack } = await issuer.clawback(addr('B'), '300', { reference: 'demo-clawback-B' })
  check(clawedBack === '300', `clawed back ${clawedBack} from B`)
  await expectBalances(issuer, { B: '700' }, addr)

  step('Per-holder freeze: freezing A')
  await issuer.freezeHolder(addr('A'), { reference: 'demo-freeze-A' })
  check((await issuer.getHolder(addr('A'))).frozen, 'A is frozen')
  await expectLedgerRejects(client, pay(addr('A'), addr('B'), '1'), 'tecLOCKED', 'frozen A cannot send to B')
  await expectLedgerRejects(client, pay(addr('B'), addr('A'), '1'), 'tecLOCKED', 'frozen A cannot receive from B')
  await expectRejected(() => issuer.issue(addr('A'), '1'), 'module refuses to issue to frozen A')
  await noteLedgerResult(client, pay(issuerAddr, addr('A'), '1'), 'issuer → frozen A (the ledger lets the issuer through; the module blocks it)')
  await noteLedgerResult(client, pay(addr('A'), issuerAddr, '1'), 'frozen A → issuer (redemption)')
  await expectLedgerAccepts(client, pay(addr('B'), addr('C'), '1'), 'other holders are unaffected (B → C)')

  step('Per-holder freeze: unfreezing A')
  await issuer.unfreezeHolder(addr('A'), { reference: 'demo-unfreeze-A' })
  check(!(await issuer.getHolder(addr('A'))).frozen, 'A is no longer frozen')
  await expectLedgerAccepts(client, pay(addr('A'), addr('B'), '1'), 'A can send again')

  step('Global freeze: freezing the whole token')
  await issuer.freezeAll({ reference: 'demo-global-freeze' })
  check((await issuer.getIssuance()).globallyFrozen, 'token is globally frozen')
  await expectLedgerRejects(client, pay(addr('A'), addr('B'), '1'), 'tecLOCKED', 'A cannot send during global freeze')
  await expectLedgerRejects(client, pay(addr('B'), addr('C'), '1'), 'tecLOCKED', 'B cannot send during global freeze')
  await expectRejected(() => issuer.issue(addr('A'), '1'), 'module refuses to issue during global freeze')
  await noteLedgerResult(client, pay(issuerAddr, addr('C'), '1'), 'issuer → C during global freeze')
  await noteLedgerResult(client, pay(addr('A'), issuerAddr, '1'), 'A → issuer during global freeze (redemption)')

  step('Global freeze: lifting it')
  await issuer.unfreezeAll({ reference: 'demo-global-unfreeze' })
  check(!(await issuer.getIssuance()).globallyFrozen, 'token is no longer globally frozen')
  await expectLedgerAccepts(client, pay(addr('A'), addr('B'), '1'), 'transfers work again')

  step('Ban: banning C')
  const { state: cState, transactions } = await issuer.ban(addr('C'), {
    reason: 'Demo: sanctions screening hit',
    reference: 'demo-ban-C',
  })
  log(`ban submitted ${transactions.length} transactions`)
  check(cState.balanceUnits === 0n, 'C holds none of the token')
  check(!cState.authorized, 'C is off the allowlist')
  check(cState.frozen, 'C is frozen')
  check(cState.banned, 'C is in the ban registry')
  await expectLedgerRejects(client, pay(issuerAddr, addr('C'), '1'), ['tecLOCKED', 'tecNO_AUTH'], 'ledger rejects issuer → C')
  await expectLedgerRejects(client, pay(addr('A'), addr('C'), '1'), ['tecLOCKED', 'tecNO_AUTH'], 'ledger rejects A → C')
  await expectRejected(() => issuer.authorizeHolder(addr('C')), 'module refuses to re-approve banned C')
  await expectRejected(() => issuer.issue(addr('C'), '1'), 'module refuses to issue to banned C')

  step('Per-holder freeze: freezing B (stays frozen)')
  await issuer.freezeHolder(addr('B'), { reference: 'demo-freeze-B' })
  await expectLedgerRejects(client, pay(addr('B'), addr('A'), '1'), 'tecLOCKED', 'frozen B cannot send')

  step('Verifying final ledger state')
  const final = await issuer.getIssuance()
  check(final.issuer === issuerAddr, 'token is issued from the issuer account')
  check(final.requireAuth && final.canLock && final.canClawback, 'all compliance controls available')
  check(!final.globallyFrozen, 'token is not globally frozen')
  const holders = Object.fromEntries(
    await Promise.all(HOLDER_NAMES.map(async (n) => [n, await issuer.getHolder(addr(n))] as const)),
  ) as Record<HolderName, HolderState>
  expectHolder('A', holders.A, { balance: '500', authorized: true, frozen: false, banned: false })
  expectHolder('B', holders.B, { balance: '700', authorized: true, frozen: true, banned: false })
  expectHolder('C', holders.C, { balance: '0', authorized: false, frozen: true, banned: true })
  check(final.outstanding === '1200', `outstanding supply is ${final.outstanding}`)

  const result = {
    issuanceId: issuer.issuanceId,
    holders: { A: addr('A'), B: addr('B'), C: addr('C') },
  }
  await saveJson(resultPath, result, 0o644)
  state.completedAt = new Date().toISOString()
  await saveJson(statePath, state)
  step(`Done. Wrote ${resultPath}`)
  console.log(JSON.stringify(result, null, 2))
}

// -----------------------------------------------------------------------------

async function assertTestnet(client: Client): Promise<void> {
  const info = await client.request({ command: 'server_info' })
  const networkId = info.result.info.network_id
  if (networkId !== TESTNET_NETWORK_ID) {
    throw new Error(`Refusing to run: expected XRPL testnet (network_id 1), connected to network_id ${networkId}`)
  }
  log(`connected to ${client.url} (rippled ${info.result.info.build_version}, network_id ${networkId})`)
  const features = await client.request({ command: 'feature' })
  const enabled = new Set(
    Object.values(features.result.features as Record<string, { name: string; enabled: boolean }>)
      .filter((f) => f.enabled)
      .map((f) => f.name),
  )
  for (const amendment of REQUIRED_AMENDMENTS) {
    if (!enabled.has(amendment)) {
      throw new Error(`Required amendment ${amendment} is not enabled on this network`)
    }
  }
  log(`required amendments enabled: ${REQUIRED_AMENDMENTS.join(', ')}`)
}

async function loadIssuer(client: Client): Promise<Wallet> {
  if (args['faucet-issuer']) {
    log('rehearsal mode: funding a throwaway issuer from the faucet')
    const { wallet } = await client.fundWallet()
    return wallet
  }
  const seed = process.env.ISSUER_SEED
  if (seed === undefined || seed === '') {
    throw new Error('Set ISSUER_SEED (or pass --faucet-issuer for a rehearsal)')
  }
  // xrpl 5.x infers the algorithm from the seed prefix; be explicit anyway.
  const wallet = Wallet.fromSeed(seed, { algorithm: seed.startsWith('sEd') ? ECDSA.ed25519 : ECDSA.secp256k1 })
  const expected = process.env.ISSUER_ADDRESS
  if (expected !== undefined && expected !== wallet.classicAddress) {
    throw new Error(`ISSUER_SEED derives ${wallet.classicAddress}, but ISSUER_ADDRESS is ${expected}`)
  }
  return wallet
}

/** Ask the server what the transaction would do against the current open ledger, without submitting it. */
async function simulate(client: Client, tx: SubmittableTransaction): Promise<string> {
  const response = await client.simulate(tx)
  return response.result.engine_result
}

async function expectLedgerRejects(
  client: Client,
  tx: SubmittableTransaction,
  expected: string | string[],
  description: string,
): Promise<void> {
  const codes = Array.isArray(expected) ? expected : [expected]
  const result = await simulate(client, tx)
  check(codes.includes(result), `${description} [${result}]`)
}

/** Record how the ledger treats a transaction where the result is informational, not a requirement. */
async function noteLedgerResult(client: Client, tx: SubmittableTransaction, description: string): Promise<void> {
  log(`ⓘ ${description}: ledger says ${await simulate(client, tx)}`)
}

async function expectLedgerAccepts(client: Client, tx: SubmittableTransaction, description: string): Promise<void> {
  const result = await simulate(client, tx)
  check(result === 'tesSUCCESS', `${description} [${result}]`)
}

async function expectRejected(action: () => Promise<unknown>, description: string): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (error instanceof ComplianceError) {
      check(true, `${description} [${error.message}]`)
      return
    }
    throw error
  }
  check(false, `${description} [was allowed]`)
}

async function expectBalances(
  issuer: MptIssuer,
  expected: Partial<Record<HolderName, string>>,
  addr: (n: HolderName) => string,
): Promise<void> {
  for (const [name, balance] of Object.entries(expected) as [HolderName, string][]) {
    const actual = (await issuer.getHolder(addr(name))).balance
    check(actual === balance, `${name} holds ${actual} (expected ${balance})`)
  }
}

function expectHolder(
  name: HolderName,
  actual: HolderState,
  expected: Pick<HolderState, 'balance' | 'authorized' | 'frozen' | 'banned'>,
): void {
  const summary = `balance=${actual.balance} authorized=${actual.authorized} frozen=${actual.frozen} banned=${actual.banned}`
  const ok =
    actual.balance === expected.balance &&
    actual.authorized === expected.authorized &&
    actual.frozen === expected.frozen &&
    actual.banned === expected.banned
  check(ok, `${name}: ${summary}`)
}

function check(condition: boolean, description: string): void {
  if (!condition) {
    throw new Error(`CHECK FAILED: ${description}`)
  }
  console.log(`  ✔ ${description}`)
}

function step(title: string): void {
  console.log(`\n== ${title}`)
}

function log(message: string): void {
  console.log(`  ${message}`)
}

function auditLog(event: AuditEvent): void {
  const parts = [event.action, event.holder, event.amount, event.reference, event.txHash].filter((p) => p !== undefined)
  console.log(`  [audit] ${parts.join(' ')}`)
}

async function saveJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
  await rename(tmp, path)
}

main().catch((error: unknown) => {
  console.error(`\nDemo failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exitCode = 1
})
