/** Re-checks the ledger state described by result.json against the demo's expected end state. */
import { readFile } from 'node:fs/promises'

import dotenv from 'dotenv'
import { Client } from 'xrpl'

import { FileBanList, loadConfig, MptIssuer } from '../src/index.js'
import { checkFinalState, type DemoHolders, formatState } from './expectations.js'

dotenv.config({ quiet: true })

async function main(): Promise<void> {
  const result = JSON.parse(await readFile('result.json', 'utf8')) as { issuanceId: string; holders: DemoHolders }
  const config = loadConfig()
  const client = new Client(config.wsUrl)
  await client.connect()
  try {
    const issuer = await MptIssuer.load(client, config.issuerWallet, result.issuanceId, {
      banList: new FileBanList(config.banListPath),
    })
    const { A, B, C } = result.holders
    console.log(
      formatState(await issuer.getIssuanceState(), {
        A: await issuer.getHolderState(A),
        B: await issuer.getHolderState(B),
        C: await issuer.getHolderState(C),
      }),
    )
    const problems = await checkFinalState(issuer, result.holders)
    if (problems.length > 0) {
      console.error(`\nFAILED:\n  ${problems.join('\n  ')}`)
      process.exitCode = 1
    } else {
      console.log('\nAll expected end-state checks passed.')
    }
  } finally {
    await client.disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
