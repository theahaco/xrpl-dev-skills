Built the TypeScript module and ran the testnet demo. [result.json](/private/tmp/ws/cad38db3011f/project/result.json) is written.

Verified at ledger **21134283**:

- **A:** approved, 500 tokens, unlocked.
- **B:** approved, 700 tokens after clawback, locked.
- **C:** zero tokens, authorization revoked; re-entry attempt rejected.
- **Global lock:** off after being exercised.

**Compliance limitation:** native MPT locks permit payments between issuer and holder in both directions. The literal absolute-freeze requirements therefore remain unmet; these exceptions were tested and documented. [Protocol implementation](https://github.com/XRPLF/rippled/blob/release/3.4.x/src/libxrpl/tx/transactors/payment/Payment.cpp#L698-L710)

Strict build and **13 tests pass**. Rerunning created no additional transactions.

[Module](/private/tmp/ws/cad38db3011f/project/src/issuer.ts) · [Usage and limitations](/private/tmp/ws/cad38db3011f/project/README.md) · [Research](/private/tmp/ws/cad38db3011f/project/RESEARCH.md) · [Changes](/private/tmp/ws/cad38db3011f/project/implementation.patch)