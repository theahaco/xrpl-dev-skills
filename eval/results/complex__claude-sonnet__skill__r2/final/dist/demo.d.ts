/**
 * End-to-end demo of the MPT issuer module against XRPL testnet.
 *
 * Exercises every compliance control (allowlist, per-holder freeze, global
 * freeze, clawback, ban) using the caller's own issuer account and three
 * freshly generated holder accounts (A, B, C), then writes result.json
 * with the issuance ID and holder addresses.
 *
 * Usage: copy .env.example to .env, set ISSUER_SEED, then `npm run demo`.
 */
import "dotenv/config";
