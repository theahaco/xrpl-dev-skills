/**
 * Independently re-check the demo's end state from raw validated ledger
 * entries (does not use the issuer module).
 *
 *   npm run verify
 */
import { readFile } from 'node:fs/promises'

import { Client } from 'xrpl'

const EXPECTED_ISSUER = 'rPmjGdHVjznFtNExiqnZbh1vLKatu6Gs3z'

interface Result {
  issuanceId: string
  holders: { A: string; B: string; C: string }
}

async function main(): Promise<void> {
  const result = JSON.parse(await readFile('result.json', 'utf8')) as Result
  const client = new Client(process.env.XRPL_WS_URL ?? 'wss://s.altnet.rippletest.net:51233')
  await client.connect()
  let failures = 0
  const check = (ok: boolean, what: string): void => {
    console.log(`${ok ? '✓' : '✗'} ${what}`)
    if (!ok) failures++
  }
  try {
    const iss = (
      await client.request({ command: 'ledger_entry', mpt_issuance: result.issuanceId, ledger_index: 'validated' })
    ).result.node as unknown as { Issuer: string; Flags: number; OutstandingAmount: string }
    check(iss.Issuer === EXPECTED_ISSUER, `issuer is ${iss.Issuer}`)
    check((iss.Flags & 0x46) === 0x46, `CanLock, RequireAuth, CanClawback set (Flags=0x${iss.Flags.toString(16)})`)
    check((iss.Flags & 0x01) === 0, 'not globally locked')

    const holding = async (account: string) => {
      const node = (
        await client.request({
          command: 'ledger_entry',
          mptoken: { mpt_issuance_id: result.issuanceId, account },
          ledger_index: 'validated',
        })
      ).result.node as unknown as { Flags: number; MPTAmount?: string }
      return { amount: node.MPTAmount ?? '0', locked: (node.Flags & 1) !== 0, authorized: (node.Flags & 2) !== 0 }
    }
    const a = await holding(result.holders.A)
    const b = await holding(result.holders.B)
    const c = await holding(result.holders.C)
    check(a.authorized && a.amount === '500' && !a.locked, `A ${JSON.stringify(a)}`)
    check(b.authorized && b.amount === '700' && b.locked, `B ${JSON.stringify(b)}`)
    check(!c.authorized && c.amount === '0', `C ${JSON.stringify(c)}`)
    check(iss.OutstandingAmount === '1200', `outstanding ${iss.OutstandingAmount}`)
  } finally {
    await client.disconnect()
  }
  if (failures > 0) {
    console.error(`${failures} check(s) failed`)
    process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
