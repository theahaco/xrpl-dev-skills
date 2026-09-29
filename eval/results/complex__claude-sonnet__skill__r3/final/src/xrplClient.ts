import { Client } from "xrpl";

export const TESTNET_WS_URL = "wss://s.altnet.rippletest.net:51233";
export const TESTNET_FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts";

/** Creates a connected xrpl.js Client with a conservative max fee guard. */
export async function connectTestnetClient(): Promise<Client> {
  const client = new Client(TESTNET_WS_URL, { maxFeeXRP: "2" });
  await client.connect();
  return client;
}
