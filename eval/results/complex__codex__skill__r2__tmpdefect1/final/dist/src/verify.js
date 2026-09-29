import { readFile } from 'node:fs/promises';
import { Client } from 'xrpl';
import { Executor, MptIssuer, TESTNET } from './issuer.js';
import { FileStore } from './storage.js';
import { verify } from './verification.js';
const result = JSON.parse(await readFile('result.json', 'utf8'));
const client = new Client(TESTNET);
try {
    await client.connect();
    const store = new FileStore('.runtime/events.jsonl');
    const executor = new Executor(client, { classicAddress: 'rNbSd1jtyvmwv5Pj91BV2iYUhT77Vo2E5u', sign() { throw new Error('Read-only verifier'); } }, store);
    const issuer = await MptIssuer.open(executor, result.issuanceId, store);
    console.log(JSON.stringify(await verify(issuer, result), null, 2));
}
finally {
    await client.disconnect();
}
