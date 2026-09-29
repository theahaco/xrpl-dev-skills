Research found a compliance mismatch: **native MPT freezes still permit holders to return tokens to the issuer**, reducing their balances. That does not satisfy your literal “can’t send” requirement. [XRPL documentation](https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens#compliance-controls)

Verified:
- Latest npm `xrpl`: **5.3.0**; changelog reviewed.
- Testnet: `MPTokensV1` and `Clawback` enabled; `DynamicMPT` disabled.
- Findings saved in [RESEARCH.md](/private/tmp/ws/abadf0c248e7/project/RESEARCH.md).

Should I use native MPT freezes with that exception, or extend the design with issuer-account deposit restrictions to block returns too?

This clarification affects the compliance guarantee and issuer-account behavior. No application code or ledger transactions have been executed, and `result.json` has not been created.