/**
 * End-to-end demo of every compliance control against XRPL testnet.
 *
 *   npm run demo            (reads ISSUER_SEED / ISSUER_ADDRESS / XRPL_WS_URL from .env)
 *
 * Creates a new issuance from the issuer account and three new holder
 * accounts (A, B, C), exercises each control, verifies the final ledger state,
 * and writes result.json. Holder seeds are saved to .secrets/holders.json.
 *
 * "Ledger check" steps submit transactions that deliberately bypass this
 * module's guards, to prove the ledger itself rejects them. They are recorded
 * on ledger as failed (tec) transactions and cost only the network fee.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'

import { Client, ECDSA, Wallet, xrpToDrops, type Payment } from 'xrpl'

import {
  buildTransfer,
  ComplianceViolationError,
  JsonFileBanRegistry,
  MptIssuer,
  optIn,
  TransactionFailedError,
  TransactionSubmitter,
  type AuditEvent,
} from '../src/index.js'

const TESTNET_NETWORK_ID = 1
const HOLDER_FUNDING_XRP = '5'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`)
  return value
}

function step(title: string): void {
  console.log(`\n=== ${title}`)
}

function ok(message: string): void {
  console.log(`  ✔ ${message}`)
}

/** Asserts the ledger rejected a transaction with one of the expected result codes. */
async function expectLedgerRejects(label: string, codes: string[], action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (err) {
    if (err instanceof TransactionFailedError && err.validated && codes.includes(err.code)) {
      ok(`ledger rejected ${label}: ${err.code} (tx ${err.hash})`)
      return
    }
    throw err
  }
  throw new Error(`Expected ledger to reject ${label} with ${codes.join('/')}, but it succeeded`)
}

/** Asserts the issuer module refused an operation before submitting anything. */
async function expectModuleRefuses(
  label: string,
  rule: ComplianceViolationError['rule'],
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action()
  } catch (err) {
    if (err instanceof ComplianceViolationError && err.rule === rule) {
      ok(`module refused ${label}: ${rule}`)
      return
    }
    throw err
  }
  throw new Error(`Expected module to refuse ${label} (${rule}), but it succeeded`)
}

async function main(): Promise<void> {
  const url = process.env.XRPL_WS_URL ?? 'wss://s.altnet.rippletest.net:51233'
  const issuerWallet = Wallet.fromSeed(requireEnv('ISSUER_SEED'), { algorithm: ECDSA.ed25519 })
  const expectedIssuer = requireEnv('ISSUER_ADDRESS')
  if (issuerWallet.classicAddress !== expectedIssuer) {
    throw new Error(`ISSUER_SEED derives ${issuerWallet.classicAddress}, expected ${expectedIssuer}`)
  }

  mkdirSync('state', { recursive: true })
  mkdirSync('.secrets', { recursive: true, mode: 0o700 })
  const auditLog = (event: AuditEvent): void => {
    appendFileSync('state/audit.log', JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n')
  }

  const client = new Client(url)
  await client.connect()
  try {
    assert.equal(client.networkID, TESTNET_NETWORK_ID, 'Refusing to run: not connected to XRPL testnet')
    const submitter = new TransactionSubmitter(client)
    const options = {
      banRegistry: new JsonFileBanRegistry('state/ban-registry.json'),
      submitter,
      expectedNetworkId: TESTNET_NETWORK_ID,
      onAudit: auditLog,
    }

    // ------------------------------------------------------------------ setup
    step('1. Create the MPT issuance (allowlist + freeze + clawback + transfers)')
    const { issuer, tx: createTx } = await MptIssuer.create(
      client,
      issuerWallet,
      {
        assetScale: 0,
        allowHolderTransfers: true,
        metadata: {
          ticker: 'RUSD',
          name: 'Regulated USD (testnet demo)',
          desc: 'Testnet demo of a regulated stablecoin-style MPT with allowlist, freeze, clawback and bans.',
          icon: 'example.com/rusd-icon.png',
          asset_class: 'rwa',
          asset_subclass: 'stablecoin',
          issuer_name: 'Example Issuer (testnet)',
        },
      },
      options,
    )
    const id = issuer.issuanceId
    ok(`issuance ${id} created in ledger ${createTx.ledgerIndex} (tx ${createTx.hash})`)
    const caps = (await issuer.getIssuance()).capabilities
    assert.deepEqual(caps, {
      allowlist: true,
      freeze: true,
      clawback: true,
      holderTransfers: true,
      escrow: false,
      trade: false,
    })
    ok(`capabilities: ${JSON.stringify(caps)}`)

    step('2. Create and fund holder accounts A, B, C')
    const holders = {
      A: Wallet.generate(ECDSA.ed25519),
      B: Wallet.generate(ECDSA.ed25519),
      C: Wallet.generate(ECDSA.ed25519),
    }
    // Save seeds before funding so the XRP is never unrecoverable.
    writeFileSync(
      '.secrets/holders.json',
      JSON.stringify(
        { issuanceId: id, holders: Object.fromEntries(Object.entries(holders).map(([k, w]) => [k, { address: w.classicAddress, seed: w.seed }])) },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
    const { A, B, C } = holders
    for (const [name, wallet] of Object.entries(holders)) {
      const fund: Payment = {
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: wallet.classicAddress,
        Amount: xrpToDrops(HOLDER_FUNDING_XRP),
      }
      const tx = await submitter.submit(issuerWallet, fund)
      ok(`${name} = ${wallet.classicAddress} funded with ${HOLDER_FUNDING_XRP} XRP (tx ${tx.hash})`)
    }

    const transfer = (from: Wallet, to: Wallet, amount: string) =>
      submitter.submit(from, buildTransfer(from.classicAddress, to.classicAddress, id, amount, issuer.assetScale))
    const rawIssuerPayment = (to: Wallet, amount: string) =>
      submitter.submit(issuerWallet, buildTransfer(issuerWallet.classicAddress, to.classicAddress, id, amount, issuer.assetScale))

    step('3. Holders opt in to the token')
    for (const [name, wallet] of Object.entries(holders)) {
      const res = await optIn(submitter, wallet, id)
      assert.ok(res.changed)
      ok(`${name} opted in (tx ${res.tx.hash})`)
    }

    // -------------------------------------------------------------- allowlist
    step('4. Allowlist: unapproved holders cannot receive the token')
    await expectModuleRefuses('issuing to unapproved A', 'not-approved', () => issuer.issue(A.classicAddress, '1'))
    await expectLedgerRejects('issuer -> unapproved A', ['tecNO_AUTH'], () => rawIssuerPayment(A, '1'))
    for (const [name, wallet] of Object.entries(holders)) {
      const res = await issuer.approveHolder(wallet.classicAddress)
      assert.ok(res.changed)
      ok(`${name} approved after KYC (tx ${res.tx.hash})`)
    }
    const again = await issuer.approveHolder(A.classicAddress)
    assert.equal(again.changed, false)
    ok(`re-approving A is a no-op (${again.changed ? '' : again.reason})`)

    step('5. Issue tokens: A 460, B 1000, C 100')
    for (const [wallet, amount] of [[A, '460'], [B, '1000'], [C, '100']] as const) {
      const res = await issuer.issue(wallet.classicAddress, amount)
      ok(`issued ${res.delivered} to ${wallet.classicAddress} (tx ${res.tx.hash})`)
    }

    // ----------------------------------------------------------- global freeze
    step('6. Global freeze')
    const gf = await issuer.freezeAll()
    assert.ok(gf.changed)
    ok(`token globally frozen (tx ${gf.tx.hash})`)
    assert.equal((await issuer.getIssuance()).globallyFrozen, true)
    await expectLedgerRejects('A -> C during global freeze', ['tecLOCKED'], () => transfer(A, C, '10'))
    await expectLedgerRejects('B -> A during global freeze', ['tecLOCKED'], () => transfer(B, A, '10'))
    await expectModuleRefuses('issuing to B during global freeze', 'globally-frozen', () => issuer.issue(B.classicAddress, '1'))
    // Informational dry run (nothing is submitted): shows why the module-level guard exists.
    try {
      const sim = await client.simulate({
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: B.classicAddress,
        Amount: { mpt_issuance_id: id, value: '1' },
      })
      console.log(`  ℹ simulate(issuer -> B during global freeze) = ${sim.result.engine_result} (ledger-level result without the module guard)`)
    } catch (err) {
      console.log(`  ℹ simulate unavailable: ${String(err)}`)
    }
    const gu = await issuer.unfreezeAll()
    assert.ok(gu.changed)
    assert.equal((await issuer.getIssuance()).globallyFrozen, false)
    ok(`global freeze lifted (tx ${gu.tx.hash})`)

    // ------------------------------------------------------- per-holder freeze
    step('7. Per-holder freeze of A')
    const fa = await issuer.freezeHolder(A.classicAddress)
    assert.ok(fa.changed)
    ok(`A frozen (tx ${fa.tx.hash})`)
    await expectLedgerRejects('frozen A -> C (send)', ['tecLOCKED'], () => transfer(A, C, '10'))
    await expectLedgerRejects('C -> frozen A (receive)', ['tecLOCKED'], () => transfer(C, A, '10'))
    await expectModuleRefuses('issuing to frozen A', 'holder-frozen', () => issuer.issue(A.classicAddress, '50'))
    const ua = await issuer.unfreezeHolder(A.classicAddress)
    assert.ok(ua.changed)
    ok(`A unfrozen (tx ${ua.tx.hash})`)
    const sendOk = await transfer(A, C, '10')
    ok(`unfrozen A can send again: A -> C 10 (tx ${sendOk.hash})`)
    const receiveOk = await issuer.issue(A.classicAddress, '50')
    ok(`unfrozen A can receive again: issued ${receiveOk.delivered} (tx ${receiveOk.tx.hash})`)

    // ---------------------------------------------------------------- clawback
    step('8. Clawback 300 from B')
    const cb = await issuer.clawback(B.classicAddress, '300')
    assert.equal(cb.clawedBack, '300')
    ok(`clawed back ${cb.clawedBack} from B (tx ${cb.tx.hash})`)

    step('9. Freeze B (stays frozen)')
    const fb = await issuer.freezeHolder(B.classicAddress)
    assert.ok(fb.changed)
    ok(`B frozen (tx ${fb.tx.hash})`)
    await expectLedgerRejects('frozen B -> A', ['tecLOCKED'], () => transfer(B, A, '1'))

    // --------------------------------------------------------------------- ban
    step('10. Ban C')
    const ban = await issuer.banHolder(C.classicAddress, 'Demo: address flagged by compliance screening')
    ok(`C banned: clawed back ${ban.clawedBack}; txs ${ban.transactions.map((t) => `${t.transactionType} ${t.hash}`).join(', ')}`)
    assert.equal(ban.clawedBack, '110')
    await expectLedgerRejects('issuer -> banned C', ['tecNO_AUTH'], () => rawIssuerPayment(C, '1'))
    await expectLedgerRejects('A -> banned C', ['tecNO_AUTH'], () => transfer(A, C, '1'))
    await expectModuleRefuses('re-approving banned C', 'banned', () => issuer.approveHolder(C.classicAddress))
    await expectModuleRefuses('issuing to banned C', 'banned', () => issuer.issue(C.classicAddress, '1'))
    await expectModuleRefuses('unfreezing banned C', 'banned', () => issuer.unfreezeHolder(C.classicAddress))

    // ------------------------------------------------------------ verification
    step('11. Verify final ledger state')
    const issuance = await issuer.getIssuance()
    assert.equal(issuance.issuer, issuerWallet.classicAddress)
    assert.equal(issuance.globallyFrozen, false)
    assert.equal(issuance.outstanding, '1200')
    const [a, b, c] = await Promise.all([A, B, C].map((w) => issuer.getHolder(w.classicAddress)))
    assert.ok(a && b && c)
    assert.deepEqual(
      { approved: a.approved, frozen: a.frozen, banned: a.banned, balance: a.balance },
      { approved: true, frozen: false, banned: false, balance: '500' },
    )
    assert.deepEqual(
      { approved: b.approved, frozen: b.frozen, banned: b.banned, balance: b.balance },
      { approved: true, frozen: true, banned: false, balance: '700' },
    )
    assert.deepEqual(
      { approved: c.approved, frozen: c.frozen, banned: c.banned, balance: c.balance },
      { approved: false, frozen: true, banned: true, balance: '0' },
    )
    console.log(JSON.stringify({ issuance, holders: { A: a, B: b, C: c } }, null, 2))
    ok('final state matches expectations')

    const result = {
      issuanceId: id,
      holders: { A: A.classicAddress, B: B.classicAddress, C: C.classicAddress },
    }
    writeFileSync('result.json', JSON.stringify(result, null, 2) + '\n')
    ok('wrote result.json')
  } finally {
    await client.disconnect()
  }
}

main().catch((err: unknown) => {
  console.error('\nDEMO FAILED:', err)
  process.exitCode = 1
})
