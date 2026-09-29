import type { Client } from 'xrpl';

import {
  FORBIDDEN_ISSUANCE_FLAGS,
  REQUIRED_ISSUANCE_FLAGS,
  fetchHolderStatus,
  fetchIssuanceStatus,
  type ComplianceRegistry,
} from '../../src/index.js';

export interface DemoResult {
  issuanceId: string;
  holders: { A: string; B: string; C: string };
}

export interface Check {
  ok: boolean;
  description: string;
  actual: string;
}

/** Checks the end state the demo must leave on the validated ledger (and in the ban registry). */
export async function checkFinalState(
  client: Client,
  issuer: string,
  result: DemoResult,
  registry?: ComplianceRegistry,
): Promise<Check[]> {
  const { issuanceId, holders } = result;
  const [issuance, a, b, c] = await Promise.all([
    fetchIssuanceStatus(client, issuanceId),
    fetchHolderStatus(client, issuanceId, holders.A),
    fetchHolderStatus(client, issuanceId, holders.B),
    fetchHolderStatus(client, issuanceId, holders.C),
  ]);

  const checks: Check[] = [];
  const check = (description: string, ok: boolean, actual: unknown) =>
    checks.push({ description, ok, actual: typeof actual === 'bigint' ? actual.toString() : JSON.stringify(actual) });

  check(`issued by ${issuer}`, issuance.issuer === issuer, issuance.issuer);
  check('has CanLock, RequireAuth, CanClawback, CanTransfer', (issuance.flags & REQUIRED_ISSUANCE_FLAGS) === REQUIRED_ISSUANCE_FLAGS, issuance.flags);
  check('has none of CanEscrow, CanTrade, CanHoldConfidentialBalance', (issuance.flags & FORBIDDEN_ISSUANCE_FLAGS) === 0, issuance.flags);
  check('not globally frozen', !issuance.globallyFrozen, issuance.globallyFrozen);
  check('outstanding supply is 1200 (A 500 + B 700)', issuance.outstandingAmount === 1200n, issuance.outstandingAmount);

  check('A is authorized', a.authorized, a.authorized);
  check('A holds 500', a.balance === 500n, a.balance);
  check('A is not frozen', a.exists && !a.frozen, a.frozen);

  check('B is authorized', b.authorized, b.authorized);
  check('B holds 700', b.balance === 700n, b.balance);
  check('B is frozen', b.frozen, b.frozen);

  check('C holds 0', c.balance === 0n && c.lockedAmount === 0n, c.balance);
  check('C is not authorized (ledger rejects transfers to C)', !c.authorized, c.authorized);
  if (registry) {
    const banned = await registry.isBanned(issuanceId, holders.C);
    check('C is in the ban registry', banned, banned);
  }
  return checks;
}

export function printChecks(checks: Check[]): boolean {
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.description}${c.ok ? '' : ` (actual: ${c.actual})`}`);
  return checks.every((c) => c.ok);
}
