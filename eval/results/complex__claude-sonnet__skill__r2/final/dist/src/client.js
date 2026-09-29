"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TESTNET_WS_URL = void 0;
exports.createTestnetClient = createTestnetClient;
const xrpl_1 = require("xrpl");
exports.TESTNET_WS_URL = "wss://s.altnet.rippletest.net:51233";
/**
 * Creates a Client pointed at XRPL testnet with a sane fee safety cap.
 * `maxFeeXRP` guards against fee-escalation surprises during congestion;
 * 2 XRP is far above what any of these transactions should ever cost.
 */
function createTestnetClient(maxFeeXRP = "2") {
    return new xrpl_1.Client(exports.TESTNET_WS_URL, { maxFeeXRP });
}
//# sourceMappingURL=client.js.map