import type { HolderState, IssuanceState, MptIssuer } from '../src/index.js'

export interface DemoHolders {
  A: string
  B: string
  C: string
}

/** The ledger state the demo must leave behind. Returns a list of mismatches (empty = all good). */
export async function checkFinalState(issuer: MptIssuer, holders: DemoHolders): Promise<string[]> {
  const [issuance, a, b, c] = await Promise.all([
    issuer.getIssuanceState(),
    issuer.getHolderState(holders.A),
    issuer.getHolderState(holders.B),
    issuer.getHolderState(holders.C),
  ])
  const problems: string[] = []
  const expect = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message)
  }

  const caps = issuance.capabilities
  expect(issuance.issuer === issuer.issuerAddress, `issuer is ${issuance.issuer}`)
  expect(caps.requireAuth && caps.canLock && caps.canClawback, `missing capabilities: ${JSON.stringify(caps)}`)
  expect(!issuance.globallyFrozen, 'token is globally frozen')

  expectHolder(a, { authorized: true, frozen: false, balance: '500', banned: false }, 'A', expect)
  expectHolder(b, { authorized: true, frozen: true, balance: '700', banned: false }, 'B', expect)
  expectHolder(c, { authorized: false, frozen: true, balance: '0', banned: true }, 'C', expect)
  expect(issuance.outstandingAmount === '1200', `outstanding supply is ${issuance.outstandingAmount}, expected 1200`)
  return problems
}

export function formatState(issuance: IssuanceState, holders: Record<string, HolderState>): string {
  const lines = [
    `Issuance ${issuance.issuanceId} (issuer ${issuance.issuer})`,
    `  outstanding=${issuance.outstandingAmount} globallyFrozen=${issuance.globallyFrozen} capabilities=${JSON.stringify(issuance.capabilities)}`,
  ]
  for (const [label, h] of Object.entries(holders)) {
    lines.push(
      `  ${label} ${h.address}: balance=${h.balance} authorized=${h.authorized} frozen=${h.frozen} banned=${h.banned}`,
    )
  }
  return lines.join('\n')
}

function expectHolder(
  actual: HolderState,
  wanted: { authorized: boolean; frozen: boolean; balance: string; banned: boolean },
  label: string,
  expect: (ok: boolean, message: string) => void,
): void {
  expect(actual.optedIn, `${label} has no MPToken entry`)
  expect(actual.authorized === wanted.authorized, `${label} authorized=${actual.authorized}, expected ${wanted.authorized}`)
  expect(actual.frozen === wanted.frozen, `${label} frozen=${actual.frozen}, expected ${wanted.frozen}`)
  expect(actual.balance === wanted.balance, `${label} balance=${actual.balance}, expected ${wanted.balance}`)
  expect(actual.banned === wanted.banned, `${label} banned=${actual.banned}, expected ${wanted.banned}`)
}
