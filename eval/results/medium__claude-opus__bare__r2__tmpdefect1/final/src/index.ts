import { writeFile } from 'node:fs/promises'
import {
  Client,
  Wallet,
  xrpToDrops,
  MPTokenIssuanceCreateFlags,
  type SubmittableTransaction,
  type TxResponse,
  type LedgerEntry,
} from 'xrpl'

const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233'
const HOLDER_FUNDING_XRP = '10'
const SEND_AMOUNT = '1000'

async function submit<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
): Promise<TxResponse<T>> {
  const response = await client.submitAndWait(tx, { autofill: true, wallet })
  const meta = response.result.meta
  const result = typeof meta === 'object' ? meta.TransactionResult : undefined
  if (result !== 'tesSUCCESS') {
    throw new Error(`${tx.TransactionType} failed: ${result ?? 'no metadata'}`)
  }
  console.log(`${tx.TransactionType}: ${response.result.hash}`)
  return response
}

async function main(): Promise<void> {
  const seed = process.env.XRPL_ISSUER_SEED
  if (!seed) throw new Error('Set XRPL_ISSUER_SEED (e.g. in .env)')
  const issuer = Wallet.fromSeed(seed)

  const client = new Client(TESTNET_URL)
  await client.connect()
  try {
    // 1. Issue an MPT that requires issuer authorization for holders.
    const create = await submit(client, issuer, {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: issuer.classicAddress,
      AssetScale: 0,
      Flags:
        MPTokenIssuanceCreateFlags.tfMPTRequireAuth |
        MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
    })
    const createMeta = create.result.meta
    const issuanceId =
      typeof createMeta === 'object' && 'mpt_issuance_id' in createMeta
        ? createMeta.mpt_issuance_id
        : undefined
    if (typeof issuanceId !== 'string') {
      throw new Error('No mpt_issuance_id in MPTokenIssuanceCreate metadata')
    }
    console.log(`Issuance ID: ${issuanceId}`)

    // 2. Create and fund a holder account from the issuer, then authorize it.
    const holder = Wallet.generate()
    await writeFile(
      'holder-wallet.json',
      JSON.stringify({ address: holder.classicAddress, seed: holder.seed }, null, 2) + '\n',
    )
    await submit(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: xrpToDrops(HOLDER_FUNDING_XRP),
    })
    console.log(`Holder: ${holder.classicAddress}`)

    // Holder opts in (creates its MPToken entry)...
    await submit(client, holder, {
      TransactionType: 'MPTokenAuthorize',
      Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    })
    // ...and the issuer approves that holder.
    await submit(client, issuer, {
      TransactionType: 'MPTokenAuthorize',
      Account: issuer.classicAddress,
      MPTokenIssuanceID: issuanceId,
      Holder: holder.classicAddress,
    })

    // 3. Send the holder 1,000 of the token.
    await submit(client, issuer, {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: SEND_AMOUNT },
    })

    // 4. Read balances back from the validated ledger.
    const token = await client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: issuanceId, account: holder.classicAddress },
      ledger_index: 'validated',
    })
    const issuance = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated',
    })
    // xrpl.js omits MPToken from its LedgerEntry union, so widen before narrowing.
    const tokenNode = token.result.node as { LedgerEntryType?: string } | undefined
    const issuanceNode = issuance.result.node
    if (tokenNode?.LedgerEntryType !== 'MPToken') {
      throw new Error('Holder MPToken entry not found')
    }
    const mptoken = tokenNode as LedgerEntry.MPToken
    if (issuanceNode?.LedgerEntryType !== 'MPTokenIssuance') {
      throw new Error('MPTokenIssuance entry not found')
    }

    // MPTAmount / OutstandingAmount are omitted from the ledger when zero.
    const holderBalance = mptoken.MPTAmount ?? '0'
    const outstandingAmount = issuanceNode.OutstandingAmount ?? '0'
    console.log(`Holder balance:     ${holderBalance}`)
    console.log(`Outstanding amount: ${outstandingAmount}`)

    const result = {
      issuanceId,
      holder: holder.classicAddress,
      holderBalance,
      outstandingAmount,
    }
    await writeFile('result.json', JSON.stringify(result, null, 2) + '\n')
    console.log('Wrote result.json')
  } finally {
    await client.disconnect()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
