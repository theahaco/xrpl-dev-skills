/**
 * End-to-end demo of every compliance control, run against the XRPL testnet.
 *
 *   npm run demo            (reads ISSUER_SEED / ISSUER_ADDRESS from .env)
 *
 * Creates a fresh MPT issuance from the issuer account, creates and funds three
 * holder accounts (A, B, C) from the issuer, exercises allowlisting, per-holder
 * and global freezes, clawback, and bans, verifies the final ledger state, and
 * writes result.json. Holder seeds are saved to state/holders.json (gitignored).
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Client, ECDSA, Wallet, type SubmittableTransaction, xrpToDrops } from 'xrpl'

import {
  ComplianceError,
  type ComplianceErrorCode,
  FileBanRegistry,
  type HolderState,
  type Logger,
  MptIssuer,
  toBaseUnits,
} from './index.js'

const WS_URL = process.env.XRPL_WS_URL ?? 'wss://s.altnet.rippletest.net:51233'
const TESTNET_NETWORK_ID = 1
const ROOT = join(import.meta.dirname, '..')
const RESULT_PATH = join(ROOT, 'result.json')
const STATE_DIR = join(ROOT, 'state')
/** XRP sent to each new holder account: covers the base reserve, one MPToken owner reserve, and fees. */
const HOLDER_FUNDING_XRP = 5

type HolderName = 'A' | 'B' | 'C'

const logger: Logger = {
  info: (message, fields) => console.log(`    · ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`),
  warn: (message, fields) => console.warn(`    ! ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`),
}

function step(title: string): void {
  console.log(`\n=== ${title}`)
}

function check(condition: boolean, description: string): void {
  if (!condition) {
    throw new Error(`Demo check failed: ${description}`)
  }
  console.log(`    ✓ ${description}`)
}

function loadIssuerWallet(): Wallet {
  const seed = process.env.ISSUER_SEED
  if (!seed) {
    throw new Error('ISSUER_SEED is not set (see .env.example)')
  }
  // xrpl v5 infers the algorithm from the seed prefix; be explicit so a wrong seed type fails loudly.
  const wallet = Wallet.fromSeed(seed, { algorithm: seed.startsWith('sEd') ? ECDSA.ed25519 : ECDSA.secp256k1 })
  const expected = process.env.ISSUER_ADDRESS
  if (expected && wallet.classicAddress !== expected) {
    throw new Error(`ISSUER_SEED derives ${wallet.classicAddress}, but ISSUER_ADDRESS is ${expected}`)
  }
  return wallet
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flush: true })
  await rename(tmp, path)
}

/** Submit a transaction signed by a holder (not the issuer) and return its engine result. */
async function submitAsHolder(client: Client, wallet: Wallet, tx: SubmittableTransaction): Promise<string> {
  const response = await client.submitAndWait(tx, { wallet, autofill: true })
  const meta = response.result.meta
  return typeof meta === 'object' ? meta.TransactionResult : 'unknown'
}

async function expectRefusal(action: Promise<unknown>, code: ComplianceErrorCode, description: string): Promise<void> {
  try {
    await action
  } catch (err) {
    if (err instanceof ComplianceError && err.code === code) {
      check(true, `${description} → refused by module (${code})`)
      return
    }
    throw err
  }
  throw new Error(`Demo check failed: ${description} was not refused`)
}

async function main(): Promise<void> {
  const issuerWallet = loadIssuerWallet()
  const client = new Client(WS_URL)
  await client.connect()
  try {
    await run(client, issuerWallet)
  } finally {
    await client.disconnect()
  }
}

async function run(client: Client, issuerWallet: Wallet): Promise<void> {
  const options = {
    client,
    wallet: issuerWallet,
    banRegistry: new FileBanRegistry(join(STATE_DIR, 'bans.json')),
    expectedNetworkId: TESTNET_NETWORK_ID,
    logger,
  }

  step(`Issuer ${issuerWallet.classicAddress} on ${WS_URL}`)
  const startingXrp = await client.getXrpBalance(issuerWallet.classicAddress)
  console.log(`    issuer balance: ${startingXrp} XRP`)

  // ------------------------------------------------------------------ issuance
  step('Create the MPT issuance (Require Auth + Can Lock + Can Clawback + Can Transfer)')
  const { issuer } = await MptIssuer.createIssuance(options, {
    assetScale: 2,
    transferable: true,
    metadata: {
      ticker: 'DUSD',
      name: 'Demo Regulated USD',
      desc: 'Testnet demo of a regulated, allowlisted USD stablecoin issued as an XRPL Multi-Purpose Token.',
      icon: 'example.com/dusd.png',
      asset_class: 'rwa',
      asset_subclass: 'stablecoin',
      issuer_name: 'Demo Issuer (testnet)',
    },
  })
  const id = issuer.issuanceId
  const issuance = await issuer.getIssuanceState()
  console.log(`    issuance ID: ${id}`)
  check(
    issuance.capabilities.requireAuth && issuance.capabilities.canLock && issuance.capabilities.canClawback,
    'issuance has allowlist, lock and clawback capabilities',
  )

  // ------------------------------------------------------------------- holders
  step(`Create holder accounts A, B, C (funded with ${HOLDER_FUNDING_XRP} XRP each from the issuer)`)
  const holders: Record<HolderName, Wallet> = {
    A: Wallet.generate(ECDSA.ed25519),
    B: Wallet.generate(ECDSA.ed25519),
    C: Wallet.generate(ECDSA.ed25519),
  }
  await writeJsonAtomic(join(STATE_DIR, 'holders.json'), {
    network: 'testnet',
    issuanceId: id,
    holders: Object.fromEntries(Object.entries(holders).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])),
  })
  for (const [name, wallet] of Object.entries(holders)) {
    const tx: SubmittableTransaction = {
      TransactionType: 'Payment',
      Account: issuerWallet.classicAddress,
      Destination: wallet.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    }
    const result = await submitAsHolder(client, issuerWallet, tx)
    check(result === 'tesSUCCESS', `holder ${name} = ${wallet.classicAddress} created`)
  }
  const { A, B, C } = holders
  const addr = { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress }

  const optIn = (w: Wallet) =>
    submitAsHolder(client, w, { TransactionType: 'MPTokenAuthorize', Account: w.classicAddress, MPTokenIssuanceID: id })
  const send = (from: Wallet, to: string, amount: string) =>
    submitAsHolder(client, from, {
      TransactionType: 'Payment',
      Account: from.classicAddress,
      Destination: to,
      Amount: { mpt_issuance_id: id, value: toBaseUnits(amount, issuer.assetScale).toString() },
    })

  step('Holders opt in to the token (holder-signed MPTokenAuthorize)')
  for (const [name, wallet] of Object.entries(holders)) {
    check((await optIn(wallet)) === 'tesSUCCESS', `holder ${name} opted in`)
  }

  // ----------------------------------------------------------------- allowlist
  step('Allowlist: only approved holders can receive the token')
  await expectRefusal(issuer.issue(addr.A, '500'), 'HOLDER_NOT_AUTHORIZED', 'issue to A before KYC approval')
  for (const name of ['A', 'B', 'C'] as const) {
    await issuer.authorizeHolder(addr[name])
    check((await issuer.getHolderState(addr[name])).authorized, `holder ${name} approved`)
  }
  check(!(await issuer.authorizeHolder(addr.A)).changed, 're-approving A is an idempotent no-op')

  step('Issue tokens: A 500, B 1000, C 250')
  await issuer.issue(addr.A, '500')
  await issuer.issue(addr.B, '1000')
  await issuer.issue(addr.C, '250')
  check((await issuer.getHolderState(addr.A)).balance === '500', 'A holds 500')
  check((await issuer.getHolderState(addr.B)).balance === '1000', 'B holds 1000')
  check((await issuer.getHolderState(addr.C)).balance === '250', 'C holds 250')

  // --------------------------------------------------------- per-holder freeze
  step('Per-holder freeze: freeze A, confirm A can neither send nor receive, then unfreeze')
  await issuer.freezeHolder(addr.A)
  check((await issuer.getHolderState(addr.A)).frozen, 'A is frozen')
  check((await send(A, addr.B, '10')) === 'tecLOCKED', 'A → B 10 rejected by ledger (tecLOCKED)')
  check((await send(B, addr.A, '10')) === 'tecLOCKED', 'B → A 10 rejected by ledger (tecLOCKED)')
  await expectRefusal(issuer.issue(addr.A, '10'), 'HOLDER_FROZEN', 'issuer → frozen A')
  await issuer.unfreezeHolder(addr.A)
  check(!(await issuer.getHolderState(addr.A)).frozen, 'A is unfrozen')
  check((await send(A, addr.B, '10')) === 'tesSUCCESS', 'A → B 10 succeeds again')
  check((await send(B, addr.A, '10')) === 'tesSUCCESS', 'B → A 10 succeeds again (balances restored)')

  // ------------------------------------------------------------------ clawback
  step('Clawback: claw back 300 from B')
  await expectRefusal(issuer.clawback(addr.B, '5000'), 'INSUFFICIENT_HOLDER_BALANCE', 'claw back more than B holds')
  const claw = await issuer.clawback(addr.B, '300')
  check(claw.clawedBack === '300', 'ledger confirms exactly 300 clawed back')
  check((await issuer.getHolderState(addr.B)).balance === '700', 'B holds 700')

  // ------------------------------------------------------------- global freeze
  step('Global freeze: freeze all movement, confirm, then lift')
  await issuer.freezeAll()
  check((await issuer.getIssuanceState()).globallyFrozen, 'token is globally frozen')
  check((await send(A, addr.B, '1')) === 'tecLOCKED', 'A → B 1 rejected by ledger (tecLOCKED)')
  check((await send(B, addr.A, '1')) === 'tecLOCKED', 'B → A 1 rejected by ledger (tecLOCKED)')
  await expectRefusal(issuer.issue(addr.A, '1'), 'GLOBALLY_FROZEN', 'issuance during global freeze')
  await issuer.unfreezeAll()
  check(!(await issuer.getIssuanceState()).globallyFrozen, 'global freeze lifted')
  check((await send(A, addr.B, '1')) === 'tesSUCCESS', 'A → B 1 succeeds again')
  check((await send(B, addr.A, '1')) === 'tesSUCCESS', 'B → A 1 succeeds again (balances restored)')

  // ----------------------------------------------------------------------- ban
  step('Ban C: record ban, freeze, revoke approval, claw back entire balance')
  const ban = await issuer.banHolder(addr.C, 'Demo: sanctions-screening match')
  check(ban.clawedBack === '250', 'all 250 clawed back from C')
  const cState = await issuer.getHolderState(addr.C)
  check(cState.balance === '0' && !cState.authorized && cState.banned, 'C holds 0, is unapproved and is on the ban list')
  check((await send(B, addr.C, '1')) === 'tecNO_AUTH', 'B → C 1 rejected by ledger (tecNO_AUTH)')
  await expectRefusal(issuer.authorizeHolder(addr.C), 'HOLDER_BANNED', 're-approving banned C')
  await expectRefusal(issuer.issue(addr.C, '1'), 'HOLDER_BANNED', 'issuing to banned C')
  check((await issuer.banHolder(addr.C, 'retry')).changed === false, 'banning C again is an idempotent no-op')

  // --------------------------------------------------------------- final state
  step('Freeze B (final state)')
  await issuer.freezeHolder(addr.B)

  step('Verify final ledger state')
  const final = await issuer.getIssuanceState()
  const state: Record<HolderName, HolderState> = {
    A: await issuer.getHolderState(addr.A),
    B: await issuer.getHolderState(addr.B),
    C: await issuer.getHolderState(addr.C),
  }
  console.table(
    Object.fromEntries(
      Object.entries(state).map(([k, s]) => [k, { address: s.address, balance: s.balance, approved: s.authorized, frozen: s.frozen, banned: s.banned }]),
    ),
  )
  check(final.issuer === issuerWallet.classicAddress, 'token is issued from the issuer account')
  check(
    final.capabilities.requireAuth && final.capabilities.canLock && final.capabilities.canClawback && final.capabilities.canTransfer,
    'allowlist, freeze, clawback and transfer capabilities are enabled',
  )
  check(!final.globallyFrozen, 'token is not globally frozen')
  check(state.A.authorized && state.A.balance === '500' && !state.A.frozen && !state.A.banned, 'A: approved, 500, not frozen')
  check(state.B.authorized && state.B.balance === '700' && state.B.frozen && !state.B.banned, 'B: approved, 700, frozen')
  check(state.C.banned && state.C.balance === '0' && !state.C.authorized, 'C: banned, 0, unapproved')
  check(final.outstandingAmount === '1200', 'outstanding supply is 1200 (500 + 700)')

  await writeJsonAtomic(RESULT_PATH, { issuanceId: id, holders: addr })
  console.log(`\nWrote ${RESULT_PATH}`)
  const endingXrp = await client.getXrpBalance(issuerWallet.classicAddress)
  console.log(`Issuer XRP: ${startingXrp} → ${endingXrp}`)
}

main().catch((err: unknown) => {
  console.error('\nDEMO FAILED:', err)
  process.exitCode = 1
})
