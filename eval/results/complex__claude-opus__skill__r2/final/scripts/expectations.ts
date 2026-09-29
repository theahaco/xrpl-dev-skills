import type { Client } from 'xrpl'

/** Target end state of the demo, checked directly against the validated ledger. */
export interface DemoResult {
  issuanceId: string
  holders: { A: string; B: string; C: string }
}

export const TESTNET_NETWORK_ID = 1

interface RawIssuance {
  Issuer: string
  Flags: number
  OutstandingAmount?: string
}

interface RawHolder {
  exists: boolean
  flags: number
  amount: bigint
}

async function readIssuance(client: Client, issuanceId: string): Promise<RawIssuance> {
  const r = await client.request({ command: 'ledger_entry', mpt_issuance: issuanceId, ledger_index: 'validated' })
  return r.result.node as unknown as RawIssuance
}

async function readHolder(client: Client, issuanceId: string, account: string): Promise<RawHolder> {
  try {
    const r = await client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account },
      ledger_index: 'validated',
    })
    const node = r.result.node as unknown as { Flags: number; MPTAmount?: string }
    return { exists: true, flags: node.Flags, amount: BigInt(node.MPTAmount ?? '0') }
  } catch (error) {
    if ((error as { data?: { error?: string } }).data?.error === 'entryNotFound') {
      return { exists: false, flags: 0, amount: 0n }
    }
    throw error
  }
}

/**
 * Returns a list of human-readable check results. Uses raw ledger_entry reads
 * rather than the issuer module so it is an independent check of the module.
 */
export async function checkFinalState(
  client: Client,
  expectedIssuer: string,
  result: DemoResult,
): Promise<{ ok: boolean; checks: { ok: boolean; description: string }[] }> {
  const checks: { ok: boolean; description: string }[] = []
  const check = (ok: boolean, description: string) => checks.push({ ok, description })

  const issuance = await readIssuance(client, result.issuanceId)
  const f = issuance.Flags
  check(issuance.Issuer === expectedIssuer, `issuance issued by ${expectedIssuer} (actual ${issuance.Issuer})`)
  check((f & 0x04) !== 0, 'allowlist (RequireAuth) enabled')
  check((f & 0x40) !== 0, 'clawback (CanClawback) enabled')
  check((f & 0x02) !== 0, 'freeze (CanLock) enabled')
  check((f & (0x08 | 0x10 | 0x80)) === 0, 'escrow, DEX trading and confidential balances disabled')
  check((f & 0x01) === 0, 'token is NOT globally frozen')

  const [a, b, c] = await Promise.all(
    [result.holders.A, result.holders.B, result.holders.C].map((h) => readHolder(client, result.issuanceId, h)),
  )
  const approved = (h: RawHolder) => h.exists && (h.flags & 0x02) !== 0
  const frozen = (h: RawHolder) => h.exists && (h.flags & 0x01) !== 0

  check(approved(a!), 'A is approved')
  check(a!.amount === 500n, `A holds 500 (actual ${a!.amount})`)
  check(!frozen(a!), 'A is NOT frozen')

  check(approved(b!), 'B is approved')
  check(b!.amount === 700n, `B holds 700 (actual ${b!.amount})`)
  check(frozen(b!), 'B is frozen')

  check(!approved(c!), 'C (banned) is NOT approved, so cannot receive the token')
  check(c!.amount === 0n, `C (banned) holds 0 (actual ${c!.amount})`)

  check(
    BigInt(issuance.OutstandingAmount ?? '0') === 1200n,
    `outstanding supply is 1200 = 500 + 700 + 0 (actual ${issuance.OutstandingAmount ?? '0'})`,
  )

  return { ok: checks.every((c) => c.ok), checks }
}
