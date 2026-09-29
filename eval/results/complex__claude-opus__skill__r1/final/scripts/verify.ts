/**
 * Independently re-checks the demo's end state on the validated ledger from result.json.
 * Needs no secrets. The ban-registry check is included when the registry file exists.
 *
 *   ISSUER_ADDRESS=r... npm run verify
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'xrpl';

import { JsonFileComplianceRegistry } from '../src/index.js';
import { demoConfig, loadEnv, requireEnv } from './lib/env.js';
import { checkFinalState, printChecks, type DemoResult } from './lib/expected-state.js';

loadEnv();
const config = demoConfig();

async function main(): Promise<void> {
  const result = JSON.parse(await readFile(config.resultPath, 'utf8')) as DemoResult;
  const registryPath = join(config.dataDir, 'compliance-registry.json');
  const registry = existsSync(registryPath) ? await JsonFileComplianceRegistry.open(registryPath) : undefined;

  const client = new Client(config.url);
  await client.connect();
  try {
    console.log(`Verifying ${result.issuanceId} on ${config.url}`);
    const ok = printChecks(await checkFinalState(client, requireEnv('ISSUER_ADDRESS'), result, registry));
    console.log(ok ? '\nAll checks passed.' : '\nSome checks FAILED.');
    if (!ok) process.exitCode = 1;
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
