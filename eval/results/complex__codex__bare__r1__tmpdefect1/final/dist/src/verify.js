import { readFile, writeFile } from 'node:fs/promises';
import { Client } from 'xrpl';
import { verify, TESTNET_URL } from './verification.js';
const client = new Client(TESTNET_URL);
try {
    await client.connect();
    const result = JSON.parse(await readFile('result.json', 'utf8'));
    const report = await verify(client, result);
    await writeFile('verification.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
}
finally {
    await client.disconnect();
}
