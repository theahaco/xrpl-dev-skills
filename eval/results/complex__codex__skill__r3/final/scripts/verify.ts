import { readFile } from 'node:fs/promises';
import { Client } from 'xrpl';
import { ENDPOINT, verify, type Result } from './common.js';
const client = new Client(ENDPOINT);
try {
  await client.connect();
  const result = JSON.parse(await readFile('result.json', 'utf8')) as Result;
  console.log(JSON.stringify(await verify(client, result), null, 2));
} finally { await client.disconnect(); }
