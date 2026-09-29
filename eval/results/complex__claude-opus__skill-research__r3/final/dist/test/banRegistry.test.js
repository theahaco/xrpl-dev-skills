"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_test_1 = require("node:test");
const index_js_1 = require("../src/index.js");
const ban = { issuanceId: 'ID1', address: 'rAddr', reason: 'r', bannedAt: '2026-01-01T00:00:00.000Z' };
(0, node_test_1.test)('FileBanRegistry persists bans per issuance and is idempotent', async () => {
    const path = (0, node_path_1.join)(await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'bans-')), 'nested', 'bans.json');
    const registry = new index_js_1.FileBanRegistry(path);
    strict_1.default.equal(await registry.isBanned('ID1', 'rAddr'), false);
    await Promise.all([registry.record(ban), registry.record(ban), registry.record({ ...ban, issuanceId: 'ID2' })]);
    strict_1.default.equal(await new index_js_1.FileBanRegistry(path).isBanned('ID1', 'rAddr'), true);
    strict_1.default.equal(await registry.isBanned('ID3', 'rAddr'), false);
    strict_1.default.equal(JSON.parse(await (0, promises_1.readFile)(path, 'utf8')).length, 2);
});
(0, node_test_1.test)('InMemoryBanRegistry keeps the first record', async () => {
    const registry = new index_js_1.InMemoryBanRegistry();
    await registry.record(ban);
    await registry.record({ ...ban, reason: 'other' });
    strict_1.default.equal((await registry.get('ID1', 'rAddr'))?.reason, 'r');
});
//# sourceMappingURL=banRegistry.test.js.map