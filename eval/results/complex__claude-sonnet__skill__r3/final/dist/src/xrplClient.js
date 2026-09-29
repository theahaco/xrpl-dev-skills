"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TESTNET_FAUCET_URL = exports.TESTNET_WS_URL = void 0;
exports.connectTestnetClient = connectTestnetClient;
const xrpl_1 = require("xrpl");
exports.TESTNET_WS_URL = "wss://s.altnet.rippletest.net:51233";
exports.TESTNET_FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts";
/** Creates a connected xrpl.js Client with a conservative max fee guard. */
async function connectTestnetClient() {
    const client = new xrpl_1.Client(exports.TESTNET_WS_URL, { maxFeeXRP: "2" });
    await client.connect();
    return client;
}
//# sourceMappingURL=xrplClient.js.map