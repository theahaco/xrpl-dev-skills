import { readFile } from 'node:fs/promises';
import { Client } from 'xrpl';
import { FileStore } from './store.js';
import { LedgerExecutor, TESTNET_URL } from './ledger.js';
import { MptIssuer } from './issuer.js';
import { verifyFinal, type DemoResult } from './verification.js';

const result = JSON.parse(await readFile('result.json', 'utf8')) as DemoResult;
const client = new Client(TESTNET_URL);
const store = await FileStore.open('.local/verify-state.json');
try {
  await client.connect();
  const ledger = new LedgerExecutor(client, store);
  await ledger.checkNetwork();
  const issuer = new MptIssuer(ledger, {
    address: 'rp6RHAeLoaj98n9QSHDCr3eAvWLPhEedDX', sign: () => { throw new Error('Read-only verifier'); },
  }, result.issuanceId);
  console.log(JSON.stringify(await verifyFinal(client, issuer, result), null, 2));
} finally { await client.disconnect(); await store.close(); }
