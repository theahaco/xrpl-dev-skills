import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import {
  Client, Wallet, MPTokenIssuanceCreateFlags,
  xrpToDrops, type SubmittableTransaction, type TransactionMetadata,
} from 'xrpl';

const endpoint = 'wss://s.altnet.rippletest.net:51233';
const issuerAddress = 'rLXBAoYLBvBmjY5sVqyei9dKGNK1x2cBcU';
const statePath = new URL('../.local/state.json', import.meta.url);
const resultPath = new URL('../result.json', import.meta.url);
const evidencePath = new URL('../ledger-evidence.json', import.meta.url);
interface State {
  holderSeed: string;
  issuanceId?: string;
  transactions: Record<string, { hash: string; blob: string }>;
}
interface Result {
  issuanceId: string;
  holder: string;
  holderBalance: string;
  outstandingAmount: string;
}
async function saveJson(path: URL, data: unknown, mode = 0o644): Promise<void> {
  const temporary = new URL(`${path.href}.tmp`);
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode });
  await rename(temporary, path);
}
async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as State;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const holder = Wallet.generate();
    if (!holder.seed) throw new Error('Generated holder has no seed');
    const state: State = { holderSeed: holder.seed, transactions: {} };
    await mkdir(new URL('../.local/', import.meta.url), { recursive: true, mode: 0o700 });
    await saveJson(statePath, state, 0o600);
    return state;
  }
}

async function readBalances(client: Client, issuanceId: string, holder: string): Promise<Result> {
  // Both objects are read from exactly the same validated ledger snapshot.
  const snapshot = await client.request({ command: 'ledger', ledger_index: 'validated' });
  const ledgerHash = snapshot.result.ledger_hash;
  const [holding, issuance] = await Promise.all([
    client.request({ command: 'ledger_entry', ledger_hash: ledgerHash,
      mptoken: { account: holder, mpt_issuance_id: issuanceId } }),
    client.request({ command: 'ledger_entry', ledger_hash: ledgerHash, mpt_issuance: issuanceId }),
  ]);
  // xrpl 5.3.0 omits MPToken from its ledger_entry response union.
  const token: unknown = holding.result.node;
  const definition = issuance.result.node;
  if (!holding.result.validated || !issuance.result.validated) throw new Error('Ledger is not validated');
  if (typeof token !== 'object' || token === null || !('LedgerEntryType' in token) ||
      token.LedgerEntryType !== 'MPToken' || !('MPTAmount' in token) || typeof token.MPTAmount !== 'string' ||
      definition.LedgerEntryType !== 'MPTokenIssuance') {
    throw new Error('Unexpected ledger entry types');
  }
  if (definition.Issuer !== issuerAddress || (definition.Flags & MPTokenIssuanceCreateFlags.tfMPTRequireAuth) === 0) {
    throw new Error('Issuer or required authorization flag does not match');
  }
  const result: Result = {
    issuanceId, holder, holderBalance: token.MPTAmount,
    outstandingAmount: definition.OutstandingAmount,
  };
  await saveJson(evidencePath, { endpoint, ledgerHash, holding: holding.result, issuance: issuance.result });
  await saveJson(resultPath, result);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main(): Promise<void> {
  const readOnly = process.argv.includes('--read');
  const client = new Client(endpoint, { connectionTimeout: 20_000, timeout: 30_000 });
  try {
    await client.connect();
    if (readOnly) {
      const previous = JSON.parse(await readFile(resultPath, 'utf8')) as Result;
      await readBalances(client, previous.issuanceId, previous.holder);
      return;
    }
    const seed = process.env.ISSUER_SEED;
    if (!seed) throw new Error('Set ISSUER_SEED to your testnet issuer seed');
    const issuer = Wallet.fromSeed(seed);
    if (issuer.classicAddress !== issuerAddress) throw new Error('Seed does not match the expected issuer');
    const state = await loadState();
    const holder = Wallet.fromSeed(state.holderSeed);

    async function submit(label: string, tx: SubmittableTransaction, wallet: Wallet): Promise<TransactionMetadata> {
      let signed = state.transactions[label];
      if (!signed) {
        const prepared = await client.autofill(tx);
        const signature = wallet.sign(prepared);
        signed = { hash: signature.hash, blob: signature.tx_blob };
        state.transactions[label] = signed;
        // Persist before submission; a retry submits only this identical transaction.
        await saveJson(statePath, state, 0o600);
      }
      let response;
      try {
        response = await client.request({ command: 'tx', transaction: signed.hash });
      } catch (error) {
        if (!(error instanceof Error) || !('data' in error) ||
            (error.data as { error?: string } | undefined)?.error !== 'txnNotFound') throw error;
      }
      if (!response?.result.validated) response = await client.submitAndWait(signed.blob);
      const meta = response.result.meta;
      if (!response.result.validated || !meta || typeof meta === 'string' || meta.TransactionResult !== 'tesSUCCESS') {
        throw new Error(`${label} did not succeed: ${JSON.stringify(meta)}`);
      }
      console.log(`${label}: tesSUCCESS https://testnet.xrpl.org/transactions/${signed.hash}`);
      return meta;
    }

    const creation = await submit('create', {
      TransactionType: 'MPTokenIssuanceCreate', Account: issuerAddress,
      AssetScale: 0, MaximumAmount: '1000',
      Flags: MPTokenIssuanceCreateFlags.tfMPTRequireAuth | MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
    }, issuer);
    if (!('mpt_issuance_id' in creation) || typeof creation.mpt_issuance_id !== 'string') {
      throw new Error('Validated creation metadata has no MPT issuance ID');
    }
    const issuanceId = creation.mpt_issuance_id;
    state.issuanceId = issuanceId;
    await saveJson(statePath, state, 0o600);
    await submit('fund-holder', {
      TransactionType: 'Payment', Account: issuerAddress,
      Destination: holder.classicAddress, Amount: xrpToDrops('10'),
    }, issuer);
    await submit('holder-opt-in', {
      TransactionType: 'MPTokenAuthorize', Account: holder.classicAddress,
      MPTokenIssuanceID: issuanceId,
    }, holder);
    await submit('issuer-approval', {
      TransactionType: 'MPTokenAuthorize', Account: issuerAddress,
      MPTokenIssuanceID: issuanceId, Holder: holder.classicAddress,
    }, issuer);
    await submit('send-tokens', {
      TransactionType: 'Payment', Account: issuerAddress, Destination: holder.classicAddress,
      Amount: { mpt_issuance_id: issuanceId, value: '1000' },
    }, issuer);
    const result = await readBalances(client, issuanceId, holder.classicAddress);
    if (result.holderBalance !== '1000' || result.outstandingAmount !== '1000') {
      throw new Error('Ledger balances do not match the expected 1000 units');
    }
  } finally {
    if (client.isConnected()) await client.disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
