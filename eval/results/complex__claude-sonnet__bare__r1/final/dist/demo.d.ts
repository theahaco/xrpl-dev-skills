/**
 * End-to-end demo of the MPT issuer module against XRP Ledger testnet.
 *
 * Issues a regulated, stablecoin-style MPT from the configured issuer
 * account, onboards three holders (A, B, C), and exercises every
 * compliance control: allowlist, per-holder freeze, global freeze,
 * clawback, and bans. Writes the resulting issuance ID and holder
 * addresses to result.json.
 *
 * Note on freeze semantics (confirmed against a live testnet run): a lock
 * (per-holder or global) blocks holder-to-holder transfers, but per the MPT
 * protocol design it does NOT block issuer-to-holder or holder-to-issuer
 * payments — those remain available so the issuer can keep managing the
 * token (distribute, clawback) during an incident or investigation. The
 * verification steps below test the transfer that a lock actually blocks:
 * a payment between two holders.
 *
 * Usage: npm run demo
 */
export {};
