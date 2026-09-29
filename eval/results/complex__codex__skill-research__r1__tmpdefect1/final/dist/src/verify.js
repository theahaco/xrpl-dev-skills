import { Client } from 'xrpl';
import { readFileSync } from 'node:fs';
import { verify } from './verify-state.js';
const client = new Client('wss://s.altnet.rippletest.net:51233');
try {
    await client.connect();
    const state = await verify(client, JSON.parse(readFileSync('result.json', 'utf8')));
    console.log(`Verified final balances and controls at ledger ${state.ledgerIndex} (${state.ledgerHash})`);
}
finally {
    await client.disconnect();
}
