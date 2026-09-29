import { decodeSeed, ECDSA, Wallet } from 'xrpl'

export interface IssuerConfig {
  wsUrl: string
  issuerWallet: Wallet
  banListPath: string
}

/** Reads issuer configuration from environment variables (see `.env.example`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): IssuerConfig {
  const wsUrl = env.XRPL_WS_URL ?? 'wss://s.altnet.rippletest.net:51233'
  if (!wsUrl.startsWith('wss://')) {
    throw new Error('XRPL_WS_URL must use wss:// so the connection is encrypted')
  }
  const seed = env.ISSUER_SEED
  if (!seed) throw new Error('ISSUER_SEED is not set')
  // Pass the algorithm explicitly (as the xrpl.js 5 changelog recommends),
  // taken from the seed's own encoding.
  const algorithm = decodeSeed(seed).type === 'ed25519' ? ECDSA.ed25519 : ECDSA.secp256k1
  return {
    wsUrl,
    issuerWallet: Wallet.fromSeed(seed, { algorithm }),
    banListPath: env.BAN_LIST_PATH ?? 'data/ban-list.json',
  }
}
