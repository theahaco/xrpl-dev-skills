import { writeFileSync } from 'node:fs'
import {
  Client,
  LedgerEntry,
  MPTokenIssuanceCreateFlags,
  Wallet,
  xrpToDrops,
  type SubmittableTransaction,
  type TransactionMetadata,
} from 'xrpl'

type MPTokenIssuanceCreateMetadata = TransactionMetadata & { mpt_issuance_id?: string }

const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233'
const AMOUNT_TO_SEND = '1000'
const HOLDER_FUNDING_XRP = '10'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

/** Autofill, sign, submit, wait for validation, and fail loudly on anything but tesSUCCESS. */
async function submit(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<TransactionMetadata> {
  const response = await client.submitAndWait(tx, { wallet, autofill: true })
  const meta = response.result.meta
  if (typeof meta !== 'object' || meta === null) {
    throw new Error(`${tx.TransactionType}: no metadata in response`)
  }
  if (meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`${tx.TransactionType} failed: ${meta.TransactionResult}`)
  }
  console.log(`  ${tx.TransactionType} validated: ${response.result.hash}`)
  return meta
}

async function main(): Promise<void> {
  const issuer = Wallet.fromSeed(requireEnv('XRPL_ISSUER_SEED'))
  const client = new Client(TESTNET_URL)
  await client.connect()

  try {
    console.log(`Issuer: ${issuer.classicAddress}`)

    // 1. Create the MPT issuance. tfMPTRequireAuth means only holders the
    //    issuer has explicitly authorized can hold the token.
    console.log('Creating MPT issuance...')
    const createMeta = (await submit(client, issuer, {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuer.classicAddress,
      AssetScale: 0,
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth,
    })) as MPTokenIssuanceCreateMetadata
    const issuanceId = createMeta.mpt_issuance_id
    if (!issuanceId) {
      throw new Error('MPTokenIssuanceCreate metadata has no mpt_issuance_id')
    }
    console.log(`  Issuance ID: ${issuanceId}`)

    // 2. Create and fund a holder account from the issuer.
    const holder = Wallet.generate()
    writeFileSync(
      'holder-wallet.json',
      JSON.stringify({ address: holder.classicAddress, seed: holder.seed }, null, 2) + '\n',
    )
    console.log(`Funding holder ${holder.classicAddress} with ${HOLDER_FUNDING_XRP} XRP...`)
    await submit(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })

    // Holder opts in (creates its MPToken entry)...
    console.log('Holder opting in to the MPT...')
    await submit(client, holder, {
      TransactionType: 'MPTokenAuthorize',
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    })

    // ...and the issuer approves that holder.
    console.log('Issuer authorizing holder...')
    await submit(client, issuer, {
      TransactionType: 'MPTokenAuthorize',
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    })

    // 3. Send the holder 1,000 units.
    console.log(`Sending ${AMOUNT_TO_SEND} MPT to holder...`)
    await submit(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: AMOUNT_TO_SEND },
    })

    // 4. Read balances back from the validated ledger.
    const issuanceResp = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated',
    })
    const issuance = issuanceResp.result.node as LedgerEntry.MPTokenIssuance
    const requireAuth = (issuance.Flags & LedgerEntry.MPTokenIssuanceFlags.lsfMPTRequireAuth) !== 0

    const tokenResp = await client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
      ledger_index: 'validated',
    })
    // MPToken isn't in xrpl.js's LedgerEntry union, so check the type at runtime before casting.
    const tokenNode: unknown = tokenResp.result.node
    if ((tokenNode as { LedgerEntryType?: string } | undefined)?.LedgerEntryType !== 'MPToken') {
      throw new Error('ledger_entry did not return an MPToken for the holder')
    }
    const token = tokenNode as LedgerEntry.MPToken

    // Both fields are omitted from the ledger entry when zero.
    const holderBalance = token.MPTAmount ?? '0'
    const outstandingAmount = issuance.OutstandingAmount ?? '0'

    console.log('\nRead back from validated ledger:')
    console.log(`  Require auth:       ${requireAuth}`)
    console.log(`  Holder balance:     ${holderBalance}`)
    console.log(`  Outstanding amount: ${outstandingAmount}`)

    const result = {
      issuanceId,
      holder: holder.classicAddress,
      holderBalance,
      outstandingAmount,
    }
    writeFileSync('result.json', JSON.stringify(result, null, 2) + '\n')
    console.log('\nWrote result.json')
  } finally {
    await client.disconnect()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
