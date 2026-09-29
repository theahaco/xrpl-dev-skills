Created the strict TypeScript project and ran it successfully on testnet. All five transactions validated; holder approval is enforced.

[result.json](/private/tmp/ws/ca5419806290/project/result.json) contains the ledger-read values:

- Holder balance: **1,000**
- Total circulation: **1,000**

Type-checking, build, and read-only verification passed. Run `npm run read` to refresh balances. See [README.md](/private/tmp/ws/ca5419806290/project/README.md) for usage; the holder’s credentials are saved locally in `.holder.json`.