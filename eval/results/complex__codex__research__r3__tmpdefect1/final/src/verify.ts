import { Runtime, readJson, writeJson, type Signer } from './runtime.js';
import { MptIssuer } from './issuer.js';
import { verify, type Result } from './verification.js';
const result = await readJson<Result>('result.json');
if (!result) throw new Error('result.json missing');
const runtime = await Runtime.open('.private');
try {
  const signer: Signer = { classicAddress: 'r4ViabjxFwnJsJQNywFYx7Z6pmp5oFVzDG', sign() { throw new Error('Read only'); } };
  const issuer = await MptIssuer.attach(runtime, signer, result.issuanceId);
  await writeJson('verification.json', await verify(issuer, result));
  console.log('Final state verified against a single validated ledger');
} finally { await runtime.close(); }
