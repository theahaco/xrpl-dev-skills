import { readFileSync } from 'node:fs';
import { Client } from 'xrpl';
import { preflight } from './issuer.js';
import { atomicJson } from './store.js';
import { TESTNET_URL, verifyFinal } from './verification.js';
const client = new Client(TESTNET_URL);
try {
    await client.connect();
    await preflight(client);
    const result = JSON.parse(readFileSync('result.json', 'utf8'));
    const evidence = await verifyFinal(client, result);
    atomicJson('verification.json', evidence);
    console.log(`All final-state assertions passed at validated ledger ${evidence.ledgerIndex}`);
}
finally {
    if (client.isConnected())
        await client.disconnect();
}
