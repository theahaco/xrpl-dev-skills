/**
 * End-to-end demo of every compliance control against the XRPL testnet.
 *
 * Env: ISSUER_SEED (required), ISSUER_ADDRESS (optional safety check), XRPL_WS_URL,
 *      RESULT_PATH (default ./result.json), DATA_DIR (default ./data).
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, Wallet, xrpToDrops } from 'xrpl'
import {
  BannedHolderError,
  FrozenError,
  IssuanceFlags,
  JsonFileBanStore,
  MptIssuer,
  optIn,
  submitAndConfirm,
  TransactionFailedError,
  transfer,
  type AuditEvent,
  type HolderState,
} from '../src/index.js'

const WS_URL = process.env['XRPL_WS_URL'] ?? 'wss://s.altnet.rippletest.net:51233'
const RESULT_PATH = process.env['RESULT_PATH'] ?? 'result.json'
const DATA_DIR = process.env['DATA_DIR'] ?? 'data'
const HOLDER_FUNDING_XRP = '3'
const EXPLORER = 'https://testnet.xrpl.org/transactions/'

function step(title: string): void {
  console.log(`\n=== ${title}`)
}

/** Asserts that an operation is refused, either by the ledger with `code` or by the module with `errorType`. */
async function expectRefused(
  label: string,
  operation: Promise<unknown>,
  expected: string | (new (...args: never[]) => Error),
): Promise<void> {
  try {
    await operation
  } catch (error) {
    const matches =
      typeof expected === 'string'
        ? error instanceof TransactionFailedError && error.engineResult === expected
        : error instanceof expected
    if (matches) {
      const how = error instanceof TransactionFailedError ? `ledger returned ${error.engineResult}` : `module refused (${(error as Error).name})`
      console.log(`  ✔ ${label}: refused as expected — ${how}`)
      return
    }
    throw new Error(`${label}: expected ${typeof expected === 'string' ? expected : expected.name}, got ${String(error)}`, {
      cause: error,
    })
  }
  throw new Error(`${label}: expected to be refused, but it succeeded`)
}

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? '✔' : '✘'} ${label}`)
  if (!ok) process.exitCode = 1
}

function describe(name: string, s: HolderState): string {
  return `${name} ${s.holder}: balance=${s.balance} authorized=${s.authorized} frozen=${s.frozen} banned=${s.banned}`
}

async function main(): Promise<void> {
  const seed = process.env['ISSUER_SEED']
  if (!seed) throw new Error('ISSUER_SEED is not set')
  const issuerWallet = Wallet.fromSeed(seed)
  const expectedAddress = process.env['ISSUER_ADDRESS']
  if (expectedAddress && expectedAddress !== issuerWallet.classicAddress) {
    throw new Error(`ISSUER_SEED derives ${issuerWallet.classicAddress}, expected ${expectedAddress}`)
  }

  const client = new Client(WS_URL)
  await client.connect()
  try {
    await mkdir(DATA_DIR, { recursive: true })
    const auditLog = join(DATA_DIR, 'audit.jsonl')
    const audit = async (event: AuditEvent): Promise<void> => {
      await appendFile(auditLog, JSON.stringify(event) + '\n')
      const tx = event.txHashes.length > 0 ? ` ${event.txHashes.map((h) => EXPLORER + h).join(' ')}` : ''
      console.log(`  [audit] ${event.action} ${event.holder ?? ''} ${event.amount ?? ''} → ${event.outcome}${tx}`)
    }
    const banStore = new JsonFileBanStore(join(DATA_DIR, 'bans.json'))

    step(`Issuer ${issuerWallet.classicAddress}: creating and funding holder accounts A, B, C`)
    const holders = { A: Wallet.generate(), B: Wallet.generate(), C: Wallet.generate() }
    // Persist holder keys before funding them, so no funded account is ever lost. Testnet only.
    await writeFile(
      join(DATA_DIR, 'holders.json'),
      JSON.stringify(
        Object.fromEntries(Object.entries(holders).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])),
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
    for (const [name, wallet] of Object.entries(holders)) {
      const { hash } = await submitAndConfirm(client, issuerWallet, {
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: wallet.classicAddress,
        Amount: xrpToDrops(HOLDER_FUNDING_XRP),
      })
      console.log(`  funded ${name} ${wallet.classicAddress} with ${HOLDER_FUNDING_XRP} XRP (${EXPLORER}${hash})`)
    }
    const { A, B, C } = holders
    const [a, b, c] = [A.classicAddress, B.classicAddress, C.classicAddress]

    step('Creating the MPT issuance')
    const issuer = await MptIssuer.create(
      client,
      issuerWallet,
      {
        assetScale: 0,
        allowHolderTransfers: true,
        metadata: {
          ticker: 'RUSD',
          name: 'Regulated USD (testnet demo)',
          desc: 'Demo of a regulated, allowlisted stablecoin-style MPT with issuer compliance controls.',
          icon: 'example.com/rusd.png',
          asset_class: 'rwa',
          asset_subclass: 'stablecoin',
          issuer_name: 'Example Issuer (testnet)',
        },
      },
      { banStore, audit },
    )
    const id = issuer.issuanceId
    console.log(`  issuance ID ${id}`)
    const config = await issuer.verifyConfiguration()
    console.log(`  flags 0x${config.flags.toString(16)}: RequireAuth, CanLock, CanClawback, CanTransfer; no escrow/trade/confidential`)

    step('Holders opt in to the token')
    for (const [name, wallet] of Object.entries(holders)) {
      const { hash } = await optIn(client, wallet, id)
      console.log(`  ${name} opted in (${EXPLORER}${hash})`)
    }

    step('Allowlist: unapproved holders cannot receive the token')
    await expectRefused('issue 500 to A before approval', issuer.issue(a, 500n), 'tecNO_AUTH')
    for (const address of [a, b, c]) await issuer.approveHolder(address)

    step('Issuing to approved holders')
    await issuer.issue(a, 500n)
    await issuer.issue(b, 1000n)
    await issuer.issue(c, 250n)

    step('Per-holder freeze of A')
    await issuer.freezeHolder(a)
    // The ledger's MPT lock does not cover issuer payments, so the module refuses them.
    await expectRefused('issuer sends 1 to frozen A', issuer.issue(a, 1n), FrozenError)
    await expectRefused('frozen A sends 1 to B', transfer(client, A, b, id, 1n), 'tecLOCKED')
    await expectRefused('B sends 1 to frozen A', transfer(client, B, a, id, 1n), 'tecLOCKED')
    await issuer.unfreezeHolder(a)
    // A round trip proves A can transact again, without changing any final balance.
    await transfer(client, A, b, id, 1n)
    await transfer(client, B, a, id, 1n)
    console.log('  ✔ after unfreeze, A→B and B→A transfers succeed')

    step('Global freeze')
    await issuer.freezeAll()
    await expectRefused('A sends 1 to B during global freeze', transfer(client, A, b, id, 1n), 'tecLOCKED')
    await expectRefused('B sends 1 to A during global freeze', transfer(client, B, a, id, 1n), 'tecLOCKED')
    await expectRefused('issuer sends 1 to B during global freeze', issuer.issue(b, 1n), FrozenError)
    await issuer.unfreezeAll()
    await transfer(client, B, a, id, 1n)
    await transfer(client, A, b, id, 1n)
    console.log('  ✔ after global unfreeze, transfers succeed')

    step('Clawback of 300 from B')
    const clawed = await issuer.clawback(b, 300n)
    console.log(`  clawed back ${clawed}`)

    step('Per-holder freeze of B (left frozen)')
    await issuer.freezeHolder(b)

    step('Ban C')
    const banned = await issuer.ban(c, 'Demo: sanctions screening hit')
    console.log(`  banned; clawed back ${banned.clawedBack}`)
    await expectRefused('re-approve banned C', issuer.approveHolder(c), BannedHolderError)
    await expectRefused('issue to banned C via module', issuer.issue(c, 1n), BannedHolderError)
    // Ledger-level enforcement, bypassing this module entirely:
    await expectRefused(
      'raw issuer Payment to C',
      submitAndConfirm(client, issuerWallet, {
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: c,
        Amount: { mpt_issuance_id: id, value: '1' },
      }),
      'tecNO_AUTH',
    )
    await expectRefused('A sends 1 to banned C', transfer(client, A, c, id, 1n), 'tecNO_AUTH')

    step('Verifying final ledger state')
    const [sa, sb, sc, issuance] = await Promise.all([
      issuer.getHolderState(a),
      issuer.getHolderState(b),
      issuer.getHolderState(c),
      issuer.verifyConfiguration(),
    ])
    for (const [name, s] of [['A', sa], ['B', sb], ['C', sc]] as const) console.log(`  ${describe(name, s)}`)
    check('issuer is the configured account', issuance.issuer === issuerWallet.classicAddress)
    check('RequireAuth, CanLock, CanClawback all set', [IssuanceFlags.lsfMPTRequireAuth, IssuanceFlags.lsfMPTCanLock, IssuanceFlags.lsfMPTCanClawback].every((f) => (issuance.flags & f) !== 0))
    check('token is not globally frozen', !issuance.globallyFrozen)
    check('A approved, holds 500, not frozen', sa.authorized && sa.balance === 500n && !sa.frozen && !sa.banned)
    check('B approved, holds 700, frozen', sb.authorized && sb.balance === 700n && sb.frozen && !sb.banned)
    check('C banned: unapproved, holds 0', sc.banned && !sc.authorized && sc.balance === 0n)
    check('outstanding supply is 1200', issuance.outstandingAmount === 1200n)
    if (process.exitCode === 1) throw new Error('Final state verification failed; result.json not written')

    const result = { issuanceId: id, holders: { A: a, B: b, C: c } }
    await writeFile(RESULT_PATH, JSON.stringify(result, null, 2) + '\n')
    console.log(`\nWrote ${RESULT_PATH}:\n${JSON.stringify(result, null, 2)}`)
  } finally {
    await client.disconnect()
  }
}

main().catch((error: unknown) => {
  console.error('\nDemo failed:', error)
  process.exitCode = 1
})
