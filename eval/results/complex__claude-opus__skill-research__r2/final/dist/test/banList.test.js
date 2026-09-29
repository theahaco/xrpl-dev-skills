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
const banList_js_1 = require("../src/banList.js");
const record = (address, reason = 'sanctions hit') => ({
    address,
    reason,
    bannedAt: '2026-09-29T00:00:00.000Z',
});
(0, node_test_1.describe)('InMemoryBanList', () => {
    (0, node_test_1.it)('records bans idempotently, keeping the first record', async () => {
        const list = new banList_js_1.InMemoryBanList();
        await list.add(record('rA'));
        await list.add(record('rA', 'second reason'));
        strict_1.default.equal(await list.isBanned('rA'), true);
        strict_1.default.equal(await list.isBanned('rB'), false);
        strict_1.default.equal((await list.get('rA'))?.reason, 'sanctions hit');
        strict_1.default.equal((await list.list()).length, 1);
    });
});
(0, node_test_1.describe)('JsonFileBanList', () => {
    (0, node_test_1.it)('persists across instances and handles concurrent writes', async () => {
        const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'banlist-'));
        try {
            const path = (0, node_path_1.join)(dir, 'nested', 'bans.json');
            const list = new banList_js_1.JsonFileBanList(path);
            strict_1.default.equal(await list.isBanned('rA'), false);
            await Promise.all([list.add(record('rA')), list.add(record('rB')), list.add(record('rC'))]);
            const reloaded = new banList_js_1.JsonFileBanList(path);
            strict_1.default.deepEqual((await reloaded.list()).map((r) => r.address).sort(), ['rA', 'rB', 'rC']);
            strict_1.default.equal(JSON.parse(await (0, promises_1.readFile)(path, 'utf8')).length, 3);
        }
        finally {
            await (0, promises_1.rm)(dir, { recursive: true, force: true });
        }
    });
    (0, node_test_1.it)('fails closed on a corrupt file instead of treating it as empty', async () => {
        const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'banlist-'));
        try {
            const path = (0, node_path_1.join)(dir, 'bans.json');
            await (0, promises_1.writeFile)(path, '{not json');
            await strict_1.default.rejects(new banList_js_1.JsonFileBanList(path).isBanned('rA'));
        }
        finally {
            await (0, promises_1.rm)(dir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=banList.test.js.map