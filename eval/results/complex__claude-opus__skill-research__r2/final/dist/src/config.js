"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadXrplConfig = loadXrplConfig;
exports.loadIssuerWallet = loadIssuerWallet;
exports.connectClient = connectClient;
const xrpl_1 = require("xrpl");
function requireEnv(env, name) {
    const value = env[name]?.trim();
    if (value === undefined || value.length === 0) {
        throw new Error(`Missing required environment variable ${name}`);
    }
    return value;
}
function loadXrplConfig(env = process.env) {
    const wsUrl = requireEnv(env, 'XRPL_WS_URL');
    if (!wsUrl.startsWith('wss://')) {
        throw new Error('XRPL_WS_URL must use wss://');
    }
    const networkId = Number(requireEnv(env, 'XRPL_NETWORK_ID'));
    if (!Number.isInteger(networkId) || networkId < 0) {
        throw new Error('XRPL_NETWORK_ID must be a non-negative integer');
    }
    return { wsUrl, networkId };
}
/**
 * Loads the issuer wallet from ISSUER_SEED. The key algorithm is chosen
 * explicitly from the seed prefix (xrpl.js v5 no longer defaults it), and the
 * derived address must match ISSUER_ADDRESS, so a wrong seed fails before
 * anything is signed.
 */
function loadIssuerWallet(env = process.env) {
    const seed = requireEnv(env, 'ISSUER_SEED');
    const expected = requireEnv(env, 'ISSUER_ADDRESS');
    const wallet = xrpl_1.Wallet.fromSeed(seed, {
        algorithm: seed.startsWith('sEd') ? xrpl_1.ECDSA.ed25519 : xrpl_1.ECDSA.secp256k1,
    });
    if (wallet.classicAddress !== expected) {
        throw new Error(`ISSUER_SEED derives ${wallet.classicAddress}, expected ISSUER_ADDRESS ${expected}`);
    }
    return wallet;
}
/**
 * Connects and checks that the server reports the expected network ID, so
 * nothing is ever signed for the wrong network.
 */
async function connectClient(config) {
    const client = new xrpl_1.Client(config.wsUrl);
    await client.connect();
    const info = await client.request({ command: 'server_info' });
    const reported = info.result.info.network_id ?? client.networkID;
    if (reported !== config.networkId) {
        await client.disconnect();
        throw new Error(`Connected to network ${String(reported)}, expected ${config.networkId}`);
    }
    return client;
}
//# sourceMappingURL=config.js.map