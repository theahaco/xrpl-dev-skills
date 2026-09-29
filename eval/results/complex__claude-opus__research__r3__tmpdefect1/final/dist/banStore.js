export class InMemoryBanStore {
    #records = new Map();
    async isBanned(address) {
        return this.#records.has(address);
    }
    async add(record) {
        if (!this.#records.has(record.address)) {
            this.#records.set(record.address, { ...record });
        }
    }
    async get(address) {
        const record = this.#records.get(address);
        return record === undefined ? undefined : { ...record };
    }
    async list() {
        return [...this.#records.values()].map((record) => ({ ...record }));
    }
}
//# sourceMappingURL=banStore.js.map