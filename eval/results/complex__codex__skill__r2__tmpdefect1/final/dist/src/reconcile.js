import { Client } from 'xrpl';
import { TESTNET } from './issuer.js';
import { FileStore } from './storage.js';
// Read-only: reports outcomes, never re-signs/re-submits a monetary operation.
const store = new FileStore('.runtime/events.jsonl');
const events = await store.events();
const settled = new Set(events.filter(e => e.type === 'settled').map(e => e.hash));
const pending = events.filter(e => e.type === 'prepared' && !settled.has(e.hash));
const client = new Client(TESTNET);
try {
    await client.connect();
    for (const entry of pending) {
        if (typeof entry.hash !== 'string' || typeof entry.lastLedgerSequence !== 'number')
            throw new Error('Invalid journal entry');
        try {
            const response = await client.request({ command: 'tx', transaction: entry.hash, binary: false });
            const r = response.result;
            console.log(JSON.stringify({ hash: entry.hash, validated: r.validated, ledgerIndex: r.ledger_index, code: typeof r.meta === 'object' ? r.meta.TransactionResult : undefined }));
        }
        catch (e) {
            if (typeof e !== 'object' || e === null || !('data' in e) || typeof e.data !== 'object' || e.data === null || !('error' in e.data) || e.data.error !== 'txnNotFound')
                throw e;
            const info = (await client.request({ command: 'server_info' })).result.info;
            console.log(JSON.stringify({ hash: entry.hash, status: 'not found; absence alone is NOT proof of failure', lastLedgerSequence: entry.lastLedgerSequence, validatedLedger: info.validated_ledger?.seq, completeLedgers: info.complete_ledgers }));
        }
    }
    if (!pending.length)
        console.log('No unsettled transactions.');
}
finally {
    await client.disconnect();
}
