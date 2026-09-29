/**
 * End-to-end demo of every compliance control against XRPL testnet.
 *
 *   npm run demo
 *
 * Reads XRPL_WS_URL and ISSUER_SEED from .env. Creates a new issuance and
 * three new holder accounts (funded from the issuer), exercises every control,
 * checks that each control actually blocks what it should, verifies the final
 * ledger state, and writes result.json.
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Client, Wallet, xrpToDrops } from 'xrpl'

import {
  FileBanRegistry,
  HolderBannedError,
  HolderFrozenError,
  InsufficientBalanceError,
  type Logger,
  MptIssuer,
  optIn,
  submitAsIssuer,
  TokenFrozenError,
  TransactionFailedError,
  transfer,
} from '../src/index.js'

const TESTNET_NETWORK_IDS = new Set([1, 2]) // testnet, devnet
const HOLDER_FUNDING_XRP = '5'
const HOLDERS_FILE = resolve('.demo-holders.json')
const RESULT_FILE = resolve('result.json')
const BAN_REGISTRY_FILE = resolve('data/bans.json')

const logger: Logger = {
  info: (msg, fields) => console.log(`    · ${msg}`, fields ? JSON.stringify(fields) : ''),
  warn: (msg, fields) => console.log(`    ! ${msg}`, fields ? JSON.stringify(fields) : ''),
}

function step(title: string): void {
  console.log(`\n▶ ${title}`)
}

function check(condition: boolean, description: string): void {
  if (!condition) throw new Error(`Check failed: ${description}`)
  console.log(`    ✓ ${description}`)
}

/** Assert that `action` is rejected, either on ledger with one of `codes` or locally with `errorType`. */
async function expectRejected(
  description: string,
  action: () => Promise<unknown>,
  expected: { codes?: string[]; errorType?: new (...args: never[]) => Error },
): Promise<void> {
  try {
    await action()
  } catch (err) {
    if (err instanceof TransactionFailedError && expected.codes?.includes(err.resultCode)) {
      console.log(`    ✓ ${description} — rejected on ledger with ${err.resultCode} (tx ${err.hash})`)
      return
    }
    if (expected.errorType && err instanceof expected.errorType) {
      console.log(`    ✓ ${description} — refused by issuer module: ${err.message}`)
      return
    }
    throw err
  }
  throw new Error(`Check failed: ${description} — expected rejection, but it succeeded`)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (see .env.example)`)
  return value
}

async function main(): Promise<void> {
  const client = new Client(requireEnv('XRPL_WS_URL'))
  await client.connect()
  try {
    await run(client)
  } finally {
    await client.disconnect()
  }
}

async function run(client: Client): Promise<void> {
  const info = await client.request({ command: 'server_info' })
  const networkId = info.result.info.network_id
  if (networkId === undefined || !TESTNET_NETWORK_IDS.has(networkId)) {
    throw new Error(`Refusing to run the demo on network_id ${networkId ?? 'unknown (mainnet?)'}`)
  }

  const issuerWallet = Wallet.fromSeed(requireEnv('ISSUER_SEED'))
  const I = issuerWallet.classicAddress
  console.log(`Issuer ${I} on network ${networkId}`)

  if (existsSync(HOLDERS_FILE)) {
    throw new Error(
      `${HOLDERS_FILE} exists from a previous run. Move it aside to run the demo again ` +
        '(it holds the seeds of the previous demo holder accounts).',
    )
  }

  // ------------------------------------------------------------------------
  step('Create the token issuance (allowlist + lock + clawback, no escrow/DEX)')
  const issuanceId = await MptIssuer.createIssuance(client, issuerWallet, {
    assetScale: 0,
    allowHolderTransfers: true,
    logger,
  })
  const issuer = await MptIssuer.load({
    client,
    wallet: issuerWallet,
    issuanceId,
    banRegistry: new FileBanRegistry(BAN_REGISTRY_FILE),
    logger,
  })
  const status = await issuer.getIssuanceStatus()
  check(
    status.flags.requireAuth && status.flags.canLock && status.flags.canClawback,
    'issuance has RequireAuth, CanLock and CanClawback',
  )

  // ------------------------------------------------------------------------
  step('Create and fund holder accounts A, B, C')
  const holders = { A: Wallet.generate(), B: Wallet.generate(), C: Wallet.generate() }
  // Persist seeds before funding so the accounts are never unrecoverable.
  await writeFile(
    HOLDERS_FILE,
    JSON.stringify(
      {
        issuanceId,
        holders: Object.fromEntries(
          Object.entries(holders).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }]),
        ),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  for (const [name, wallet] of Object.entries(holders)) {
    await submitAsIssuer(client, issuerWallet, {
      TransactionType: 'Payment',
      Account: I,
      Destination: wallet.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })
    console.log(`    · ${name} = ${wallet.classicAddress} (funded ${HOLDER_FUNDING_XRP} XRP)`)
  }
  const { A, B, C } = holders
  const a = A.classicAddress
  const b = B.classicAddress
  const c = C.classicAddress

  // ------------------------------------------------------------------------
  step('Holders opt in (create their MPToken)')
  for (const w of [A, B, C]) await optIn(client, w, issuanceId)
  check(!(await issuer.getHolderStatus(a)).approved, 'A has opted in but is not yet approved')

  step('Allowlist: unapproved holders cannot receive the token')
  await expectRejected('issuing 1 to unapproved A', () => issuer.issue(a, '1'), {
    codes: ['tecNO_AUTH'],
  })

  step('Approve A, B and C after KYC')
  for (const addr of [a, b, c]) await issuer.approveHolder(addr)
  for (const addr of [a, b, c]) check((await issuer.getHolderStatus(addr)).approved, `${addr} approved`)

  // ------------------------------------------------------------------------
  step('Issue tokens: A 400, B 1000, C 250')
  await issuer.issue(a, '400')
  await issuer.issue(b, '1000')
  await issuer.issue(c, '250')

  // ------------------------------------------------------------------------
  step('Clawback: recover 300 from B')
  await issuer.clawback(b, '300')
  check((await issuer.getHolderStatus(b)).balance === '700', 'B holds 700')
  await expectRejected('clawing back more than B holds', () => issuer.clawback(b, '701'), {
    errorType: InsufficientBalanceError,
  })

  // ------------------------------------------------------------------------
  step('Per-holder freeze: freeze A')
  await issuer.freezeHolder(a)
  check((await issuer.getHolderStatus(a)).frozen, 'A is frozen')
  await expectRejected('issuing 100 to frozen A', () => issuer.issue(a, '100'), {
    errorType: HolderFrozenError,
  })
  await expectRejected('frozen A sending 1 to B', () => transfer(client, A, b, issuanceId, 1n), {
    codes: ['tecLOCKED'],
  })
  await expectRejected('B sending 1 to frozen A', () => transfer(client, B, a, issuanceId, 1n), {
    codes: ['tecLOCKED'],
  })

  step('Per-holder freeze: unfreeze A, then A can receive again')
  await issuer.unfreezeHolder(a)
  check(!(await issuer.getHolderStatus(a)).frozen, 'A is not frozen')
  await issuer.issue(a, '100')
  check((await issuer.getHolderStatus(a)).balance === '500', 'A holds 500')

  // ------------------------------------------------------------------------
  step('Global freeze: freeze all movement of the token')
  await issuer.freezeAll()
  check((await issuer.getIssuanceStatus()).globallyFrozen, 'token is globally frozen')
  await expectRejected('A sending 1 to B during global freeze', () => transfer(client, A, b, issuanceId, 1n), {
    codes: ['tecLOCKED'],
  })
  await expectRejected('issuing 1 to B during global freeze', () => issuer.issue(b, '1'), {
    errorType: TokenFrozenError,
  })

  step('Global freeze: lift it')
  await issuer.unfreezeAll()
  check(!(await issuer.getIssuanceStatus()).globallyFrozen, 'token is not globally frozen')

  // ------------------------------------------------------------------------
  step('Ban C')
  check((await issuer.getHolderStatus(c)).balance === '250', 'C holds 250 before the ban')
  const ban = await issuer.ban(c, 'Demo: sanctions screening hit')
  check(ban.clawedBack === '250', 'ban clawed back all 250 from C')
  const cStatus = await issuer.getHolderStatus(c)
  check(cStatus.balance === '0' && !cStatus.approved && cStatus.banned, 'C holds 0, is unapproved and banned')

  step('Banned C cannot receive the token again')
  await expectRejected('module issuing 1 to C', () => issuer.issue(c, '1'), { errorType: HolderBannedError })
  await expectRejected('module re-approving C', () => issuer.approveHolder(c), { errorType: HolderBannedError })
  await expectRejected(
    'raw issuer Payment to C bypassing the module',
    () =>
      submitAsIssuer(client, issuerWallet, {
        TransactionType: 'Payment',
        Account: I,
        Destination: c,
        Amount: { mpt_issuance_id: issuanceId, value: '1' },
      }),
    { codes: ['tecNO_AUTH', 'tecLOCKED'] },
  )
  await expectRejected('A sending 1 to C', () => transfer(client, A, c, issuanceId, 1n), {
    codes: ['tecNO_AUTH', 'tecLOCKED'],
  })

  // ------------------------------------------------------------------------
  step('Freeze B')
  await issuer.freezeHolder(b)
  await expectRejected('frozen B sending 1 to A', () => transfer(client, B, a, issuanceId, 1n), {
    codes: ['tecLOCKED'],
  })

  // ------------------------------------------------------------------------
  step('Verify final ledger state')
  const [finalIssuance, sA, sB, sC] = await Promise.all([
    issuer.getIssuanceStatus(),
    issuer.getHolderStatus(a),
    issuer.getHolderStatus(b),
    issuer.getHolderStatus(c),
  ])
  check(finalIssuance.issuer === I, `issuance ${issuanceId} is issued by ${I}`)
  check(
    finalIssuance.flags.requireAuth && finalIssuance.flags.canLock && finalIssuance.flags.canClawback,
    'all controls available (RequireAuth, CanLock, CanClawback)',
  )
  check(!finalIssuance.globallyFrozen, 'token is not globally frozen')
  check(sA.approved && sA.balance === '500' && !sA.frozen, 'A: approved, 500, not frozen')
  check(sB.approved && sB.balance === '700' && sB.frozen, 'B: approved, 700, frozen')
  check(sC.banned && sC.balance === '0' && !sC.approved, 'C: banned, 0, not approved')
  check(finalIssuance.outstanding === '1200', 'outstanding supply is 1200')

  const result = { issuanceId, holders: { A: a, B: b, C: c } }
  await writeFile(RESULT_FILE, JSON.stringify(result, null, 2) + '\n')
  console.log(`\nDone. Wrote ${RESULT_FILE}:\n${JSON.stringify(result, null, 2)}`)
}

main().catch((err: unknown) => {
  console.error('\nDemo failed:', err)
  process.exitCode = 1
})
