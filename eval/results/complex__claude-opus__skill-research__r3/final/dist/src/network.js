"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveNetwork = resolveNetwork;
exports.connect = connect;
exports.walletFromSeed = walletFromSeed;
const xrpl_1 = require("xrpl");
const errors_js_1 = require("./errors.js");
const NETWORKS = {
    mainnet: { url: 'wss://xrplcluster.com', networkId: 0 },
    testnet: { url: 'wss://s.altnet.rippletest.net:51233', networkId: 1 },
    devnet: { url: 'wss://s.devnet.rippletest.net:51233', networkId: 2 },
};
function resolveNetwork(name) {
    if (!(name in NETWORKS))
        throw new errors_js_1.ValidationError(`Unknown network "${name}" (expected ${Object.keys(NETWORKS).join(', ')})`);
    return NETWORKS[name];
}
/** Connects and verifies the server is on the expected network, so we never sign for the wrong chain. */
async function connect(network) {
    const client = new xrpl_1.Client(network.url);
    await client.connect();
    if (client.networkID !== undefined && client.networkID !== network.networkId) {
        await client.disconnect();
        throw new errors_js_1.ValidationError(`${network.url} reports network_id ${client.networkID}, expected ${network.networkId}`);
    }
    if (client.networkID === undefined) {
        // Networks with IDs <= 1024 (mainnet, testnet, devnet) don't require NetworkID in transactions,
        // so autofill still works; but the server must tell us which network it is.
        const info = await client.request({ command: 'server_info' });
        if (info.result.info.network_id !== network.networkId) {
            await client.disconnect();
            throw new errors_js_1.ValidationError(`${network.url} did not confirm network_id ${network.networkId}`);
        }
    }
    return client;
}
/**
 * Loads a wallet from a family seed. The key algorithm follows the seed prefix
 * (`sEd…` = ed25519), as in xrpl.js v5. If `expectedAddress` is given, the
 * derived address must match it.
 */
function walletFromSeed(seed, expectedAddress) {
    const algorithm = seed.startsWith('sEd') ? xrpl_1.ECDSA.ed25519 : xrpl_1.ECDSA.secp256k1;
    const wallet = xrpl_1.Wallet.fromSeed(seed, { algorithm });
    if (expectedAddress && wallet.classicAddress !== expectedAddress) {
        throw new errors_js_1.ValidationError(`Seed derives ${wallet.classicAddress}, expected ${expectedAddress}`);
    }
    return wallet;
}
//# sourceMappingURL=network.js.map