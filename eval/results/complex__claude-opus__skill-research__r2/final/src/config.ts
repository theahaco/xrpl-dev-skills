import { Client, ECDSA, Wallet } from 'xrpl'

export interface XrplConfig {
  wsUrl: string
  networkId: number
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

export function loadXrplConfig(env: NodeJS.ProcessEnv = process.env): XrplConfig {
  const wsUrl = requireEnv(env, 'XRPL_WS_URL')
  if (!wsUrl.startsWith('wss://')) {
    throw new Error('XRPL_WS_URL must use wss://')
  }
  const networkId = Number(requireEnv(env, 'XRPL_NETWORK_ID'))
  if (!Number.isInteger(networkId) || networkId < 0) {
    throw new Error('XRPL_NETWORK_ID must be a non-negative integer')
  }
  return { wsUrl, networkId }
}

/**
 * Loads the issuer wallet from ISSUER_SEED. The key algorithm is chosen
 * explicitly from the seed prefix (xrpl.js v5 no longer defaults it), and the
 * derived address must match ISSUER_ADDRESS, so a wrong seed fails before
 * anything is signed.
 */
export function loadIssuerWallet(env: NodeJS.ProcessEnv = process.env): Wallet {
  const seed = requireEnv(env, 'ISSUER_SEED')
  const expected = requireEnv(env, 'ISSUER_ADDRESS')
  const wallet = Wallet.fromSeed(seed, {
    algorithm: seed.startsWith('sEd') ? ECDSA.ed25519 : ECDSA.secp256k1,
  })
  if (wallet.classicAddress !== expected) {
    throw new Error(`ISSUER_SEED derives ${wallet.classicAddress}, expected ISSUER_ADDRESS ${expected}`)
  }
  return wallet
}

/**
 * Connects and checks that the server reports the expected network ID, so
 * nothing is ever signed for the wrong network.
 */
export async function connectClient(config: XrplConfig): Promise<Client> {
  const client = new Client(config.wsUrl)
  await client.connect()
  const info = await client.request({ command: 'server_info' })
  const reported = info.result.info.network_id ?? client.networkID
  if (reported !== config.networkId) {
    await client.disconnect()
    throw new Error(`Connected to network ${String(reported)}, expected ${config.networkId}`)
  }
  return client
}
