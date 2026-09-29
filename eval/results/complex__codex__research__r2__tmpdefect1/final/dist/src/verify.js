import { readFileSync } from 'node:fs';
import { Client } from 'xrpl';
import { TESTNET } from './issuer.js';
import { verify } from './verification.js';
const client = new Client(TESTNET);
try {
    await client.connect();
    console.log(JSON.stringify(await verify(client, JSON.parse(readFileSync('result.json', 'utf8'))), null, 2));
}
finally {
    await client.disconnect();
}
