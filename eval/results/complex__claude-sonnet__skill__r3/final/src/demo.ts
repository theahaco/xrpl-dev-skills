/**
 * End-to-end demo of the MPT issuer module against XRPL testnet.
 *
 * Exercises every compliance control (allowlist, clawback, bans, per-holder
 * freeze, global freeze) against three holder accounts (A, B, C), then
 * writes result.json with the resulting issuance ID and holder addresses.
 *
 * Run with: npm run demo
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Client, Wallet, xrpToDrops, type Payment } from "xrpl";
import { MPTIssuer } from "./mptIssuer";
import { optIn } from "./mptHolder";
import { submit, submitAndRequireSuccess } from "./txSubmit";
import { TESTNET_WSS_URL } from "./network";

const ISSUER_SEED = "<TESTNET_SEED_REDACTED>";
const HOLDER_FUNDING_XRP = "3";

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

function section(title: string): void {
  log("");
  log(`=== ${title} ===`);
}

/** Sends `value` units of the issuance to `to`, expecting the payment to be rejected on-ledger. */
async function expectPaymentRejected(
  client: Client,
  issuer: Wallet,
  issuanceId: string,
  to: string,
  value: string,
  reason: string,
): Promise<void> {
  const tx: Payment = {
    TransactionType: "Payment",
    Account: issuer.address,
    Destination: to,
    Amount: { mpt_issuance_id: issuanceId, value },
  };
  const outcome = await submit(client, issuer, tx);
  if (outcome.engineResult === "tesSUCCESS") {
    throw new Error(
      `Expected payment to ${to} to be rejected (${reason}), but it succeeded (hash ${outcome.hash}).`,
    );
  }
  log(`  blocked as expected: ${outcome.engineResult} (${reason})`);
}

/**
 * Attempts `issuer.send()` (the module's own guarded entry point) and
 * expects it to throw. Used for freeze cases: the XRPL protocol's lock only
 * restricts the holder's own outgoing transfers, not the issuer minting new
 * tokens to them, so this control is enforced by the module itself rather
 * than by a rejected on-ledger transaction (contrast with
 * `expectPaymentRejected`, which proves protocol-level enforcement).
 */
async function expectSendRejected(issuer: MPTIssuer, to: string, value: string, reason: string): Promise<void> {
  try {
    await issuer.send(to, value);
  } catch (err) {
    log(`  blocked as expected by the issuer module: ${(err as Error).message} (${reason})`);
    return;
  }
  throw new Error(`Expected send() to ${to} to be rejected by the issuer module (${reason}), but it succeeded.`);
}

async function fundHolder(client: Client, issuer: Wallet, holder: Wallet, label: string): Promise<void> {
  const tx: Payment = {
    TransactionType: "Payment",
    Account: issuer.address,
    Destination: holder.address,
    Amount: xrpToDrops(HOLDER_FUNDING_XRP),
  };
  await submitAndRequireSuccess(client, issuer, tx);
  log(`Funded holder ${label} (${holder.address}) with ${HOLDER_FUNDING_XRP} XRP`);
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_WSS_URL);
  await client.connect();
  log(`Connected to ${TESTNET_WSS_URL}`);

  try {
    const issuerWallet = Wallet.fromSeed(ISSUER_SEED);
    log(`Issuer account: ${issuerWallet.address}`);

    const walletA = Wallet.generate();
    const walletB = Wallet.generate();
    const walletC = Wallet.generate();

    section("Funding holder accounts from the issuer");
    await fundHolder(client, issuerWallet, walletA, "A");
    await fundHolder(client, issuerWallet, walletB, "B");
    await fundHolder(client, issuerWallet, walletC, "C");

    section("Creating the MPT issuance");
    const issuer = await MPTIssuer.create(client, issuerWallet, {
      assetScale: 2,
      maximumAmount: "1000000000000",
      transferFee: 0,
      metadata: JSON.stringify({
        ticker: "ERD",
        name: "Example Regulated Dollar",
        desc: "Demo regulated stablecoin-style MPT issued for compliance-controls testing on testnet.",
        icon: "https://example.org/erd-icon.png",
        asset_class: "rwa",
        asset_subclass: "stablecoin",
        issuer_name: "Example Issuer Co.",
      }),
    });
    log(`Issuance created: ${issuer.issuanceId}`);
    const issuanceAfterCreate = await issuer.getIssuance();
    log(
      `  requireAuth=${issuanceAfterCreate.requireAuth} canLock=${issuanceAfterCreate.canLock} ` +
        `canClawback=${issuanceAfterCreate.canClawback}`,
    );

    section("Holders opt in (required before issuer can approve or send)");
    await optIn(client, walletA, issuer.issuanceId);
    log(`Holder A (${walletA.address}) opted in`);
    await optIn(client, walletB, issuer.issuanceId);
    log(`Holder B (${walletB.address}) opted in`);
    await optIn(client, walletC, issuer.issuanceId);
    log(`Holder C (${walletC.address}) opted in`);

    section("Allowlist: unapproved holders cannot receive the token");
    await expectPaymentRejected(
      client,
      issuerWallet,
      issuer.issuanceId,
      walletC.address,
      "1",
      "holder C is not yet KYC-approved",
    );

    section("Allowlist: issuer approves A, B, C after KYC");
    await issuer.approveHolder(walletA.address);
    log(`Holder A approved`);
    await issuer.approveHolder(walletB.address);
    log(`Holder B approved`);
    await issuer.approveHolder(walletC.address);
    log(`Holder C approved`);

    section("Issuer sends tokens to approved holders");
    await issuer.send(walletA.address, "500");
    log(`Sent 500 to A`);
    await issuer.send(walletB.address, "1000");
    log(`Sent 1000 to B`);
    await issuer.send(walletC.address, "250");
    log(`Sent 250 to C`);

    section("Per-holder freeze: freeze A, confirm blocked, then unfreeze");
    await issuer.freezeHolder(walletA.address);
    log(`Holder A frozen`);
    await expectSendRejected(issuer, walletA.address, "1", "holder A is frozen");
    await issuer.unfreezeHolder(walletA.address);
    log(`Holder A unfrozen`);

    section("Clawback: claw back 300 from B");
    await issuer.clawback(walletB.address, "300");
    const bAfterClawback = await issuer.getHolder(walletB.address);
    log(`Holder B balance after clawback: ${bAfterClawback.balance}`);

    section("Per-holder freeze: freeze B (left frozen)");
    await issuer.freezeHolder(walletB.address);
    log(`Holder B frozen`);

    section("Global freeze: halt all movement, confirm blocked, then lift it");
    await issuer.freezeGlobal();
    log(`Global freeze engaged`);
    await expectSendRejected(issuer, walletA.address, "1", "global freeze is active");
    await issuer.unfreezeGlobal();
    log(`Global freeze lifted`);

    section("Bans: ban holder C");
    await issuer.ban(walletC.address);
    log(`Holder C banned (clawed back and unapproved)`);
    await expectPaymentRejected(
      client,
      issuerWallet,
      issuer.issuanceId,
      walletC.address,
      "1",
      "holder C is banned",
    );

    section("Final ledger state");
    const finalIssuance = await issuer.getIssuance();
    const finalA = await issuer.getHolder(walletA.address);
    const finalB = await issuer.getHolder(walletB.address);
    const finalC = await issuer.getHolder(walletC.address);
    log(`Issuance globally locked: ${finalIssuance.globallyLocked}`);
    log(`Holder A: balance=${finalA.balance} authorized=${finalA.authorized} locked=${finalA.locked}`);
    log(`Holder B: balance=${finalB.balance} authorized=${finalB.authorized} locked=${finalB.locked}`);
    log(`Holder C: balance=${finalC.balance} authorized=${finalC.authorized} locked=${finalC.locked}`);

    const checks: Array<[boolean, string]> = [
      [finalIssuance.globallyLocked === false, "issuance must not be globally frozen at the end"],
      [finalA.balance === "500", "A must hold 500"],
      [finalA.authorized === true, "A must be approved"],
      [finalA.locked === false, "A must not be frozen"],
      [finalB.balance === "700", "B must hold 700"],
      [finalB.authorized === true, "B must be approved"],
      [finalB.locked === true, "B must be frozen"],
      [finalC.balance === "0", "C must hold 0 (banned)"],
      [finalC.authorized === false, "C must be unapproved (banned)"],
    ];
    const failures = checks.filter(([ok]) => !ok).map(([, msg]) => msg);
    if (failures.length > 0) {
      throw new Error(`Final state does not match expectations:\n  - ${failures.join("\n  - ")}`);
    }
    log("All final-state checks passed.");

    const resultPath = path.join(__dirname, "..", "result.json");
    const result = {
      issuanceId: issuer.issuanceId,
      holders: {
        A: walletA.address,
        B: walletB.address,
        C: walletC.address,
      },
    };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
    log("");
    log(`Wrote ${resultPath}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
