/**
 * Testnet demo: creates a compliance-controlled MPT from the issuer account,
 * creates holders A, B and C, and exercises every control. Each step checks
 * the resulting ledger state, and each expected rejection is checked for the
 * exact reason it was rejected.
 *
 *   npm run demo
 *
 * Reads XRPL_WS_URL, XRPL_EXPECTED_NETWORK_ID, ISSUER_SEED and ISSUER_ADDRESS from `.env`.
 * Writes holder seeds to `.secrets/holders.json`, the ban registry to
 * `data/bans.json`, a step log to `demo-log.json`, and the summary to `result.json`.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { strict as assert } from 'node:assert'

import { Client, ECDSA, Wallet, xrpToDrops, MPTokenAuthorizeFlags } from 'xrpl'

import {
  ComplianceError,
  JsonFileBanRegistry,
  MptIssuer,
  type ComplianceErrorCode,
  type HolderState,
  type Logger,
} from './index.js'
import { submitAndRequireSuccess, submitAndWaitForOutcome } from './ledger.js'

const HOLDER_FUNDING_XRP = '5'

interface LogEntry {
  step: string
  tx?: string | undefined
  result?: string | undefined
  detail?: unknown
}
const steps: LogEntry[] = []

function record(entry: LogEntry): void {
  steps.push(entry)
  const suffix = [entry.result, entry.tx].filter(Boolean).join(' ')
  console.log(`  - ${entry.step}${suffix ? `  [${suffix}]` : ''}`)
}

const logger: Logger = {
  info: () => undefined,
  warn: (message, fields) => console.log(`    ! ${message} ${fields ? JSON.stringify(fields) : ''}`),
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name} (see .env)`)
  return value
}

async function main(): Promise<void> {
  const url = requireEnv('XRPL_WS_URL')
  const expectedNetworkId = Number(requireEnv('XRPL_EXPECTED_NETWORK_ID'))
  const issuerWallet = Wallet.fromSeed(requireEnv('ISSUER_SEED'), { algorithm: ECDSA.ed25519 })
  const expectedIssuer = requireEnv('ISSUER_ADDRESS')
  if (issuerWallet.classicAddress !== expectedIssuer) {
    throw new Error(`ISSUER_SEED derives ${issuerWallet.classicAddress}, expected ${expectedIssuer}`)
  }

  const client = new Client(url)
  await client.connect()
  try {
    await run(client, issuerWallet, expectedNetworkId)
  } finally {
    await writeFile('demo-log.json', JSON.stringify(steps, null, 2) + '\n')
    await client.disconnect()
  }
}

async function run(client: Client, issuerWallet: Wallet, expectedNetworkId: number): Promise<void> {
  console.log(`Issuer ${issuerWallet.classicAddress} on network ${String(client.networkID)}`)

  // ------------------------------------------------------------ holders
  console.log('\n1. Create and fund holder accounts')
  const holders = {
    A: Wallet.generate(ECDSA.ed25519),
    B: Wallet.generate(ECDSA.ed25519),
    C: Wallet.generate(ECDSA.ed25519),
  }
  // Save seeds before funding, so funded accounts are never orphaned.
  await mkdir('.secrets', { recursive: true, mode: 0o700 })
  await writeFile(
    '.secrets/holders.json',
    JSON.stringify(
      Object.fromEntries(Object.entries(holders).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])),
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  for (const [name, wallet] of Object.entries(holders)) {
    const out = await submitAndRequireSuccess(client, issuerWallet, {
      TransactionType: 'Payment',
      Account: issuerWallet.classicAddress,
      Destination: wallet.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })
    record({ step: `Funded holder ${name} ${wallet.classicAddress} with ${HOLDER_FUNDING_XRP} XRP`, tx: out.hash, result: out.result })
  }
  const { A, B, C } = holders

  // ------------------------------------------------------------ issuance
  console.log('\n2. Create the MPT issuance')
  const bans = new JsonFileBanRegistry('data/bans.json')
  const mpt = await MptIssuer.createIssuance(
    { client, issuerWallet, expectedNetworkId, logger, banRegistry: bans },
    {
      assetScale: 0,
      maximumAmount: '1000000000',
      allowHolderTransfers: true,
      metadata: {
        ticker: 'RUSD',
        name: 'Regulated USD (testnet demo)',
        desc: 'Testnet demo of a regulated, stablecoin-style MPT with allowlist, clawback, ban and freeze controls.',
        icon: 'https://xrpl.org/favicon.ico',
        asset_class: 'rwa',
        asset_subclass: 'stablecoin',
        issuer_name: 'Demo Issuer',
      },
    },
  )
  const issuance = await mpt.getIssuanceState()
  assert.ok(issuance.canLock && issuance.requireAuth && issuance.canClawback && issuance.canTransfer)
  assert.ok(!issuance.canEscrow && !issuance.canTrade && !issuance.globallyFrozen)
  record({ step: `Created issuance ${mpt.issuanceId} (flags 0x${issuance.flags.toString(16)})`, detail: issuance })

  const id = mpt.issuanceId
  const mptAmount = (value: string) => ({ mpt_issuance_id: id, value })
  const holderPay = (from: Wallet, to: Wallet, value: string) =>
    submitAndWaitForOutcome(client, from, {
      TransactionType: 'Payment',
      Account: from.classicAddress,
      Destination: to.classicAddress,
      Amount: mptAmount(value),
    })

  async function expectLedgerRejection(step: string, expected: string, attempt: () => ReturnType<typeof holderPay>) {
    const out = await attempt()
    assert.equal(out.result, expected, `${step}: expected ${expected}, got ${out.result} (${out.hash})`)
    record({ step: `${step} -> rejected by ledger`, tx: out.hash, result: out.result })
  }

  async function expectModuleRefusal(step: string, code: ComplianceErrorCode, attempt: () => Promise<unknown>) {
    await assert.rejects(attempt, (err: unknown) => err instanceof ComplianceError && err.code === code, step)
    record({ step: `${step} -> refused by module`, result: code })
  }

  async function expectHolder(name: string, wallet: Wallet, expected: Partial<HolderState>) {
    const state = await mpt.getHolderState(wallet.classicAddress)
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(state[key as keyof HolderState], value, `holder ${name}.${key}: expected ${String(value)}, got ${String(state[key as keyof HolderState])}`)
    }
    return state
  }

  // ------------------------------------------------------------ allowlist
  console.log('\n3. Allowlist')
  for (const [name, wallet] of Object.entries(holders)) {
    const out = await submitAndRequireSuccess(client, wallet, {
      TransactionType: 'MPTokenAuthorize',
      Account: wallet.classicAddress,
      MPTokenIssuanceID: id,
    })
    record({ step: `Holder ${name} opted in (MPTokenAuthorize)`, tx: out.hash, result: out.result })
  }
  await expectModuleRefusal('Issue 100 to A before approval', 'HOLDER_NOT_AUTHORIZED', () => mpt.issue(A.classicAddress, '100'))
  await expectLedgerRejection('Raw issuer payment to unapproved A', 'tecNO_AUTH', () => holderPay(issuerWallet, A, '100'))
  for (const [name, wallet] of Object.entries(holders)) {
    const out = await mpt.authorizeHolder(wallet.classicAddress)
    record({ step: `Approved holder ${name} after KYC`, tx: out?.hash, result: out?.result })
    await expectHolder(name, wallet, { authorized: true, frozen: false, balance: '0' })
  }

  console.log('\n4. Issue tokens')
  for (const [name, wallet, amount] of [['A', A, '400'], ['B', B, '1000'], ['C', C, '250']] as const) {
    const out = await mpt.issue(wallet.classicAddress, amount)
    record({ step: `Issued ${amount} to ${name}`, tx: out.hash, result: out.result })
  }
  await expectHolder('A', A, { balance: '400' })
  await expectHolder('B', B, { balance: '1000' })
  await expectHolder('C', C, { balance: '250' })

  // ------------------------------------------------------------ per-holder freeze
  console.log('\n5. Per-holder freeze (A)')
  let out = await mpt.freezeHolder(A.classicAddress)
  record({ step: 'Froze A', tx: out?.hash, result: out?.result })
  await expectHolder('A', A, { frozen: true })
  await expectLedgerRejection('Frozen A sends 1 to C', 'tecLOCKED', () => holderPay(A, C, '1'))
  await expectLedgerRejection('C sends 1 to frozen A', 'tecLOCKED', () => holderPay(C, A, '1'))
  await expectModuleRefusal('Issue 75 to frozen A', 'HOLDER_FROZEN', () => mpt.issue(A.classicAddress, '75'))
  out = await mpt.unfreezeHolder(A.classicAddress)
  record({ step: 'Unfroze A', tx: out?.hash, result: out?.result })
  await expectHolder('A', A, { frozen: false, balance: '400' })
  out = await mpt.issue(A.classicAddress, '75')
  record({ step: 'Issued 75 to unfrozen A (receiving works again)', tx: out.hash, result: out.result })
  await expectHolder('A', A, { balance: '475' })

  // ------------------------------------------------------------ clawback
  console.log('\n6. Clawback (B)')
  await expectModuleRefusal('Claw back 5000 from B (more than B holds)', 'INSUFFICIENT_BALANCE', () => mpt.clawback(B.classicAddress, '5000'))
  const claw = await mpt.clawback(B.classicAddress, '300')
  assert.equal(claw.clawedBack, '300')
  record({ step: `Clawed back ${claw.clawedBack} from B`, tx: claw.outcome?.hash, result: claw.outcome?.result })
  await expectHolder('B', B, { balance: '700' })

  // ------------------------------------------------------------ global freeze
  console.log('\n7. Global freeze')
  out = await mpt.freezeAll()
  record({ step: 'Globally froze the token', tx: out?.hash, result: out?.result })
  assert.equal((await mpt.getIssuanceState()).globallyFrozen, true)
  await expectLedgerRejection('B sends 1 to C during global freeze', 'tecLOCKED', () => holderPay(B, C, '1'))
  await expectLedgerRejection('C sends 25 to A during global freeze', 'tecLOCKED', () => holderPay(C, A, '25'))
  await expectModuleRefusal('Issue 10 to C during global freeze', 'GLOBALLY_FROZEN', () => mpt.issue(C.classicAddress, '10'))
  out = await mpt.unfreezeAll()
  record({ step: 'Lifted global freeze', tx: out?.hash, result: out?.result })
  assert.equal((await mpt.getIssuanceState()).globallyFrozen, false)
  const transfer = await holderPay(C, A, '25')
  assert.equal(transfer.result, 'tesSUCCESS', `C -> A after global unfreeze: ${transfer.result}`)
  record({ step: 'C sent 25 to A after global unfreeze (transfers work again)', tx: transfer.hash, result: transfer.result })
  await expectHolder('A', A, { balance: '500' })
  await expectHolder('C', C, { balance: '225' })

  // ------------------------------------------------------------ ban
  console.log('\n8. Ban (C)')
  const ban = await mpt.ban(C.classicAddress, 'Demo: sanctions screening hit')
  record({ step: `Banned C, clawed back ${ban.clawedBack}`, tx: ban.transactions.join(','), result: 'tesSUCCESS', detail: ban })
  assert.equal(ban.clawedBack, '225')
  await expectHolder('C', C, { balance: '0', authorized: false, frozen: true })
  await expectModuleRefusal('Issue 10 to banned C', 'HOLDER_BANNED', () => mpt.issue(C.classicAddress, '10'))
  await expectModuleRefusal('Re-approve banned C', 'HOLDER_BANNED', () => mpt.authorizeHolder(C.classicAddress))
  await expectModuleRefusal('Unfreeze banned C', 'HOLDER_BANNED', () => mpt.unfreezeHolder(C.classicAddress))
  await expectLedgerRejection('Raw issuer payment to banned C', 'tecNO_AUTH', () => holderPay(issuerWallet, C, '10'))
  await expectLedgerRejection('A sends 1 to banned C', 'tecNO_AUTH', () => holderPay(A, C, '1'))
  const reopt = await submitAndWaitForOutcome(client, C, {
    TransactionType: 'MPTokenAuthorize',
    Account: C.classicAddress,
    MPTokenIssuanceID: id,
    Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
  })
  // Informational only: fixCleanup3_4_0 (not yet on testnet) makes this fail for a
  // frozen MPToken. Either way C can't receive, because a new MPToken is unauthorized.
  record({ step: 'C tries to delete its (locked, empty) MPToken', tx: reopt.hash, result: reopt.result })
  if (reopt.result === 'tesSUCCESS') {
    // Re-create it so the final state still shows C as unauthorized + frozen.
    await expectHolder('C', C, { optedIn: false })
    const recreate = await submitAndRequireSuccess(client, C, {
      TransactionType: 'MPTokenAuthorize',
      Account: C.classicAddress,
      MPTokenIssuanceID: id,
    })
    record({ step: 'C re-created its MPToken', tx: recreate.hash, result: recreate.result })
    await expectLedgerRejection('Raw issuer payment to C after it re-opted in', 'tecNO_AUTH', () => holderPay(issuerWallet, C, '10'))
    out = await mpt.freezeHolder(C.classicAddress)
    record({ step: 'Re-froze C', tx: out?.hash, result: out?.result })
  }

  // ------------------------------------------------------------ final freeze of B
  console.log('\n9. Freeze B')
  out = await mpt.freezeHolder(B.classicAddress)
  record({ step: 'Froze B', tx: out?.hash, result: out?.result })

  // ------------------------------------------------------------ final state
  console.log('\n10. Verify final ledger state')
  const final = await mpt.getIssuanceState()
  assert.equal(final.globallyFrozen, false)
  assert.equal(final.issuer, issuerWallet.classicAddress)
  assert.equal(final.outstanding, '1200')
  const a = await expectHolder('A', A, { authorized: true, frozen: false, balance: '500' })
  const b = await expectHolder('B', B, { authorized: true, frozen: true, balance: '700' })
  const c = await expectHolder('C', C, { authorized: false, frozen: true, balance: '0' })
  assert.ok(await bans.isBanned(C.classicAddress))
  record({ step: 'Final state verified', detail: { issuance: final, A: a, B: b, C: c } })
  console.log(JSON.stringify({ issuance: final, A: a, B: b, C: c }, null, 2))

  const result = {
    issuanceId: id,
    holders: { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress },
  }
  await writeFile('result.json', JSON.stringify(result, null, 2) + '\n')
  console.log('\nWrote result.json')
}

main().catch((err: unknown) => {
  console.error('\nDemo failed:', err)
  process.exitCode = 1
})
