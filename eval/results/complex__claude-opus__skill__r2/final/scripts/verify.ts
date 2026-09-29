/**
 * Read-only check of the ledger state recorded in result.json. Needs no keys.
 *
 *   XRPL_ISSUER_ADDRESS=r... npm run verify
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Client } from 'xrpl'
import { checkFinalState, type DemoResult } from './expectations'

async function main() {
  const issuer = process.env.XRPL_ISSUER_ADDRESS
  if (!issuer) throw new Error('Set XRPL_ISSUER_ADDRESS to the expected issuer address')
  const result = JSON.parse(await fs.readFile(path.resolve(__dirname, '..', 'result.json'), 'utf8')) as DemoResult
  const client = new Client(process.env.XRPL_WS_URL ?? 'wss://s.altnet.rippletest.net:51233')
  await client.connect()
  try {
    const verdict = await checkFinalState(client, issuer, result)
    for (const c of verdict.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.description}`)
    if (!verdict.ok) process.exitCode = 1
  } finally {
    await client.disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
