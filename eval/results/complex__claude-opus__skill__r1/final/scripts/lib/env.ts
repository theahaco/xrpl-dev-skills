import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Wallet } from 'xrpl';

export const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233';

export function loadEnv(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

export interface DemoConfig {
  url: string;
  dataDir: string;
  resultPath: string;
}

export function demoConfig(): DemoConfig {
  return {
    url: process.env.XRPL_WS_URL ?? TESTNET_URL,
    dataDir: resolve(process.env.DATA_DIR ?? '.data'),
    resultPath: resolve(process.env.RESULT_PATH ?? 'result.json'),
  };
}

/** Loads the issuer wallet from ISSUER_SEED, cross-checking ISSUER_ADDRESS when set. */
export function issuerWallet(): Wallet {
  const wallet = Wallet.fromSeed(requireEnv('ISSUER_SEED'));
  const expected = process.env.ISSUER_ADDRESS;
  if (expected && expected !== wallet.classicAddress) {
    throw new Error(`ISSUER_SEED derives ${wallet.classicAddress}, but ISSUER_ADDRESS is ${expected}`);
  }
  return wallet;
}
