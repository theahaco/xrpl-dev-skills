import { Client, ECDSA, Wallet } from 'xrpl'
import { ValidationError } from './errors.js'

const NETWORKS = {
  mainnet: { url: 'wss://xrplcluster.com', networkId: 0 },
  testnet: { url: 'wss://s.altnet.rippletest.net:51233', networkId: 1 },
  devnet: { url: 'wss://s.devnet.rippletest.net:51233', networkId: 2 },
} as const

export type NetworkName = keyof typeof NETWORKS

export interface NetworkConfig {
  url: string
  /** Expected network_id. The connection is refused if the server reports another. */
  networkId: number
}

export function resolveNetwork(name: string): NetworkConfig {
  if (!(name in NETWORKS)) throw new ValidationError(`Unknown network "${name}" (expected ${Object.keys(NETWORKS).join(', ')})`)
  return NETWORKS[name as NetworkName]
}

/** Connects and verifies the server is on the expected network, so we never sign for the wrong chain. */
export async function connect(network: NetworkConfig): Promise<Client> {
  const client = new Client(network.url)
  await client.connect()
  if (client.networkID !== undefined && client.networkID !== network.networkId) {
    await client.disconnect()
    throw new ValidationError(`${network.url} reports network_id ${client.networkID}, expected ${network.networkId}`)
  }
  if (client.networkID === undefined) {
    // Networks with IDs <= 1024 (mainnet, testnet, devnet) don't require NetworkID in transactions,
    // so autofill still works; but the server must tell us which network it is.
    const info = await client.request({ command: 'server_info' })
    if (info.result.info.network_id !== network.networkId) {
      await client.disconnect()
      throw new ValidationError(`${network.url} did not confirm network_id ${network.networkId}`)
    }
  }
  return client
}

/**
 * Loads a wallet from a family seed. The key algorithm follows the seed prefix
 * (`sEd…` = ed25519), as in xrpl.js v5. If `expectedAddress` is given, the
 * derived address must match it.
 */
export function walletFromSeed(seed: string, expectedAddress?: string): Wallet {
  const algorithm = seed.startsWith('sEd') ? ECDSA.ed25519 : ECDSA.secp256k1
  const wallet = Wallet.fromSeed(seed, { algorithm })
  if (expectedAddress && wallet.classicAddress !== expectedAddress) {
    throw new ValidationError(`Seed derives ${wallet.classicAddress}, expected ${expectedAddress}`)
  }
  return wallet
}
