/**
 * End-to-end demo of every compliance control against XRPL testnet.
 *
 * Usage: npm run demo   (reads XRPL_URL and ISSUER_SEED from .env)
 *
 * Final ledger state:
 *   A: approved, 500, not frozen (was frozen and unfrozen)
 *   B: approved, sent 1000, 300 clawed back -> 700, frozen
 *   C: sent some, then banned -> 0, approval revoked, frozen
 *   Token: globally frozen and unfrozen -> not globally frozen
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { Client, Wallet, xrpToDrops } from 'xrpl'
import {
  FileBanStore,
  type HolderState,
  MptIssuer,
  MptIssuerError,
  REQUIRED_ISSUANCE_FLAGS,
  TransactionFailedError,
  bigintReplacer,
  optIn,
  submitAndValidate,
  transfer,
} from '../src/index.js'

const HOLDER_FUNDING_XRP = '10'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`)
  return value
}

const log = (msg: string) => console.log(`    ${msg}`)
const step = (title: string) => console.log(`\n== ${title}`)

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/**
 * Assert that `action` is rejected, either by the ledger (`expected` is the result
 * code, e.g. tecLOCKED) or locally by the module (`expected` is the error class name).
 */
async function expectRejected(
  label: string,
  expected: string | string[],
  action: () => Promise<unknown>,
): Promise<void> {
  const allowed = typeof expected === 'string' ? [expected] : expected
  try {
    await action()
  } catch (err) {
    const code =
      err instanceof TransactionFailedError ? err.code : err instanceof MptIssuerError ? err.name : undefined
    if (code === undefined) throw err
    assert(allowed.includes(code), `${label}: expected ${allowed.join(' or ')}, got ${code}`)
    const where = err instanceof TransactionFailedError ? ` (tx ${err.hash})` : ' (refused locally, nothing submitted)'
    log(`rejected as expected: ${label} -> ${code}${where}`)
    return
  }
  throw new Error(`${label}: expected rejection with ${expected}, but it succeeded`)
}

async function expectHolder(issuer: MptIssuer, name: string, address: string, expected: Partial<HolderState>) {
  const actual = await issuer.getHolderState(address)
  for (const [key, value] of Object.entries(expected) as [keyof HolderState, unknown][]) {
    assert(actual[key] === value, `${name}.${key}: expected ${String(value)}, got ${String(actual[key])}`)
  }
  log(`${name}: ${JSON.stringify(actual, bigintReplacer)}`)
}

async function main() {
  const client = new Client(requireEnv('XRPL_URL'))
  await client.connect()
  try {
    const issuerWallet = Wallet.fromSeed(requireEnv('ISSUER_SEED'))
    console.log(`Issuer: ${issuerWallet.classicAddress}`)

    // ---------------------------------------------------------------- setup
    step('Create and fund holder accounts A, B, C')
    const holders = { A: Wallet.generate(), B: Wallet.generate(), C: Wallet.generate() }
    await mkdir('data', { recursive: true })
    await writeFile(
      'data/demo-wallets.json',
      JSON.stringify(
        Object.fromEntries(Object.entries(holders).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])),
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
    for (const [name, wallet] of Object.entries(holders)) {
      const res = await submitAndValidate(client, issuerWallet, {
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: wallet.classicAddress,
        Amount: xrpToDrops(HOLDER_FUNDING_XRP),
      })
      log(`${name} = ${wallet.classicAddress}, funded ${HOLDER_FUNDING_XRP} XRP (tx ${res.hash})`)
    }
    const { A, B, C } = holders
    const a = A.classicAddress
    const b = B.classicAddress
    const c = C.classicAddress

    step('Create the MPT issuance with all compliance controls')
    const issuer = await MptIssuer.createIssuance(
      client,
      issuerWallet,
      {
        assetScale: 0,
        // XLS-89 metadata so explorers can display the token.
        metadata: {
          ticker: 'RUSD',
          name: 'Regulated USD (testnet demo)',
          desc: 'Testnet demo of a regulated stablecoin-style MPT',
          icon: 'https://xrpl.org/favicon.ico',
          asset_class: 'rwa',
          asset_subclass: 'stablecoin',
          issuer_name: 'Demo Issuer',
        },
      },
      { banStore: new FileBanStore('data/bans.json'), log },
    )
    const id = issuer.issuanceId
    const issuance = await issuer.getIssuanceState()
    assert((issuance.flags & REQUIRED_ISSUANCE_FLAGS) === REQUIRED_ISSUANCE_FLAGS, 'issuance flags')
    log(`flags 0x${issuance.flags.toString(16)} (CanLock | RequireAuth | CanTransfer | CanClawback)`)

    // ------------------------------------------------------------ allowlist
    step('Allowlist: holders opt in, but cannot receive until approved')
    for (const [name, wallet] of Object.entries(holders)) {
      const res = await optIn(client, wallet, id)
      log(`${name} opted in (tx ${res.hash})`)
    }
    await expectRejected('issue 500 to A before approval', 'tecNO_AUTH', () => issuer.issue(a, 500n))

    step('Allowlist: approve A, B, C after KYC')
    for (const address of [a, b, c]) await issuer.approveHolder(address)

    step('Issue tokens')
    await issuer.issue(a, 500n)
    await issuer.issue(b, 1000n)
    await issuer.issue(c, 250n)
    await expectHolder(issuer, 'A', a, { authorized: true, balance: 500n })
    await expectHolder(issuer, 'B', b, { authorized: true, balance: 1000n })
    await expectHolder(issuer, 'C', c, { authorized: true, balance: 250n })

    // --------------------------------------------------------- global freeze
    step('Global freeze: no holder can move the token')
    await issuer.freezeGlobal()
    assert((await issuer.getIssuanceState()).globallyFrozen, 'token should be globally frozen')
    await expectRejected('A sends 10 to B during global freeze', 'tecLOCKED', () => transfer(client, A, b, id, 10n))
    await expectRejected('B sends 10 to A during global freeze', 'tecLOCKED', () => transfer(client, B, a, id, 10n))

    step('Global freeze: lift it')
    await issuer.unfreezeGlobal()
    assert(!(await issuer.getIssuanceState()).globallyFrozen, 'token should not be globally frozen')

    // ------------------------------------------------------ per-holder freeze
    step('Per-holder freeze: freeze A')
    await issuer.freezeHolder(a)
    await expectHolder(issuer, 'A', a, { frozen: true })
    await expectRejected('frozen A sends 10 to B', 'tecLOCKED', () => transfer(client, A, b, id, 10n))
    await expectRejected('B sends 10 to frozen A', 'tecLOCKED', () => transfer(client, B, a, id, 10n))

    step('Per-holder freeze: unfreeze A')
    await issuer.unfreezeHolder(a)
    await expectHolder(issuer, 'A', a, { frozen: false, balance: 500n })

    // --------------------------------------------------------------- clawback
    step('Clawback: claw back 300 from B')
    await expectRejected('claw back more than B holds', 'ValidationError', () => issuer.clawback(b, 5000n))
    await issuer.clawback(b, 300n)
    await expectHolder(issuer, 'B', b, { balance: 700n })

    // -------------------------------------------------------------------- ban
    step('Ban C')
    const ban = await issuer.ban(c, 'Demo: sanctions screening hit')
    log(`clawed back ${ban.clawedBack} from C in ${ban.transactions.length} transactions`)
    await expectHolder(issuer, 'C', c, { balance: 0n, authorized: false, frozen: true })
    await expectRejected('module refuses to re-approve C', 'HolderBannedError', () => issuer.approveHolder(c))
    await expectRejected('module refuses to issue to C', 'HolderBannedError', () => issuer.issue(c, 1n))
    await expectRejected('module refuses to unfreeze C', 'HolderBannedError', () => issuer.unfreezeHolder(c))
    await expectRejected('A sends 10 to banned C (ledger)', 'tecNO_AUTH', () => transfer(client, A, c, id, 10n))
    // C holds nothing, is frozen and unauthorized; the ledger checks authorization first.
    await expectRejected('banned C sends to A (ledger)', ['tecNO_AUTH', 'tecLOCKED', 'tecINSUFFICIENT_FUNDS'], () =>
      transfer(client, C, a, id, 1n),
    )

    // ---------------------------------------------------- final holder freeze
    step('Per-holder freeze: freeze B (stays frozen)')
    await issuer.freezeHolder(b)
    await expectRejected('frozen B sends 10 to A', 'tecLOCKED', () => transfer(client, B, a, id, 10n))

    // ------------------------------------------------------------ final state
    step('Verify final ledger state')
    const final = await issuer.getIssuanceState()
    assert(final.issuer === issuerWallet.classicAddress, 'issuer')
    assert((final.flags & REQUIRED_ISSUANCE_FLAGS) === REQUIRED_ISSUANCE_FLAGS, 'all controls enabled')
    assert(!final.globallyFrozen, 'not globally frozen')
    assert(final.outstandingAmount === 1200n, `outstanding should be 1200, got ${final.outstandingAmount}`)
    log(`issuance: ${JSON.stringify(final, bigintReplacer)}`)
    await expectHolder(issuer, 'A', a, { optedIn: true, authorized: true, frozen: false, balance: 500n })
    await expectHolder(issuer, 'B', b, { optedIn: true, authorized: true, frozen: true, balance: 700n })
    await expectHolder(issuer, 'C', c, { optedIn: true, authorized: false, frozen: true, balance: 0n })
    assert(await issuer.isBanned(c), 'C on ban list')

    const result = { issuanceId: id, holders: { A: a, B: b, C: c } }
    await writeFile('result.json', JSON.stringify(result, null, 2) + '\n')
    console.log(`\nAll checks passed. Wrote result.json:\n${JSON.stringify(result, null, 2)}`)
  } finally {
    await client.disconnect()
  }
}

main().catch((err) => {
  console.error('\nDEMO FAILED:', err)
  process.exitCode = 1
})
