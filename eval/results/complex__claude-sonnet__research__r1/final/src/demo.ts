import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { Client, Wallet } from "xrpl";

import { optIntoIssuance } from "./holder";
import { MptIssuer } from "./mptIssuer";
import { submitAndAssertSuccess } from "./txSubmit";

const TESTNET_WS = "wss://s.altnet.rippletest.net:51233";
const ISSUER_SEED = "<TESTNET_SEED_REDACTED>";
const HOLDER_FUNDING_XRP = "3";

function log(step: string): void {
  console.log(`\n=== ${step} ===`);
}

/** Runs `fn` and throws unless it rejects — used to prove a control actually blocks an action. */
async function expectFailure(description: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.log(`  [blocked as expected] ${description}: ${(err as Error).message}`);
    return;
  }
  throw new Error(`Expected this to fail but it succeeded: ${description}`);
}

async function fundWithXrp(client: Client, issuerWallet: Wallet, destination: string, amountXrp: string): Promise<void> {
  await submitAndAssertSuccess(client, issuerWallet, {
    TransactionType: "Payment",
    Account: issuerWallet.address,
    Destination: destination,
    Amount: String(BigInt(amountXrp) * 1_000_000n),
  });
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_WS);
  await client.connect();
  console.log(`Connected to ${TESTNET_WS}`);

  const issuerWallet = Wallet.fromSeed(ISSUER_SEED);
  console.log(`Issuer: ${issuerWallet.address}`);

  log("Creating holder accounts A, B, C");
  const walletA = Wallet.generate();
  const walletB = Wallet.generate();
  const walletC = Wallet.generate();
  console.log(`A: ${walletA.address}`);
  console.log(`B: ${walletB.address}`);
  console.log(`C: ${walletC.address}`);

  log("Funding holder accounts from the issuer");
  for (const wallet of [walletA, walletB, walletC]) {
    await fundWithXrp(client, issuerWallet, wallet.address, HOLDER_FUNDING_XRP);
    console.log(`  funded ${wallet.address} with ${HOLDER_FUNDING_XRP} XRP`);
  }

  const issuer = new MptIssuer(client, issuerWallet);

  log("Creating the MPT issuance");
  const issuanceId = await issuer.createIssuance({
    ticker: "USDX",
    name: "Example Regulated Stablecoin",
    issuerName: "Example Issuer Inc.",
    icon: "https://example.com/usdx-icon.png",
    description: "Demo regulated stablecoin-style MPT with allowlist, freeze, and clawback controls.",
    assetClass: "rwa",
    assetScale: 0,
    maximumAmount: "1000000000",
    transferable: true,
  });
  console.log(`Issuance ID: ${issuanceId}`);

  log("Holders opt in, issuer approves (allowlist)");
  for (const wallet of [walletA, walletB, walletC]) {
    await optIntoIssuance(client, wallet, issuanceId);
    await issuer.approveHolder(wallet.address);
    console.log(`  approved ${wallet.address}`);
  }

  log("Allowlist enforcement check: unapproved holder cannot receive the MPT");
  const walletD = Wallet.generate();
  await fundWithXrp(client, issuerWallet, walletD.address, HOLDER_FUNDING_XRP);
  await optIntoIssuance(client, walletD, issuanceId);
  await expectFailure("payment to an opted-in but unapproved holder D", async () => {
    await issuer.send(walletD.address, 1);
  });

  log("Distributing tokens: 500 to A, 1000 to B, 250 to C");
  await issuer.send(walletA.address, 500);
  await issuer.send(walletB.address, 1000);
  await issuer.send(walletC.address, 250);

  log("Per-holder freeze: freeze A, confirm blocked, then unfreeze A");
  // Note: on XRPL, a per-holder MPT lock only blocks that holder's transfers
  // with *other holders* (tecLOCKED) — issuer<->holder payments are exempt
  // by protocol design, so the issuer can still administer a frozen account.
  // The enforcement that matters for "can't send or receive" is therefore
  // checked via holder-to-holder payments involving the frozen account.
  await issuer.freezeHolder(walletA.address);
  assert.equal((await issuer.getHolderState(walletA.address))?.individuallyLocked, true);
  await expectFailure("frozen holder A sending to holder C", async () => {
    await submitAndAssertSuccess(client, walletA, {
      TransactionType: "Payment",
      Account: walletA.address,
      Destination: walletC.address,
      Amount: { mpt_issuance_id: issuanceId, value: "1" },
    });
  });
  await expectFailure("holder C sending to frozen holder A", async () => {
    await submitAndAssertSuccess(client, walletC, {
      TransactionType: "Payment",
      Account: walletC.address,
      Destination: walletA.address,
      Amount: { mpt_issuance_id: issuanceId, value: "1" },
    });
  });
  await issuer.unfreezeHolder(walletA.address);
  assert.equal((await issuer.getHolderState(walletA.address))?.individuallyLocked, false);
  console.log("  A frozen then unfrozen; A is unfrozen now");

  log("Clawback: recover 300 from B (1000 -> 700)");
  await issuer.clawback(walletB.address, 300);
  const bAfterClawback = await issuer.getHolderState(walletB.address);
  assert.equal(bAfterClawback?.balance, "700");
  console.log(`  B balance after clawback: ${bAfterClawback?.balance}`);

  log("Per-holder freeze: freeze B and leave it frozen");
  await issuer.freezeHolder(walletB.address);
  await expectFailure("holder-to-holder payment sent by frozen holder B", async () => {
    await submitAndAssertSuccess(client, walletB, {
      TransactionType: "Payment",
      Account: walletB.address,
      Destination: walletA.address,
      Amount: { mpt_issuance_id: issuanceId, value: "1" },
    });
  });
  console.log("  B is frozen (left frozen for final state)");

  log("Global freeze: lock the entire token, confirm blocked, then lift it");
  // Same caveat as per-holder freeze: global lock blocks holder-to-holder
  // transfers, not issuer<->holder payments. Use A -> C (neither individually
  // frozen) to isolate the effect of the global lock specifically.
  await issuer.freezeGlobal();
  assert.equal((await issuer.getIssuanceState()).globallyLocked, true);
  await expectFailure("holder-to-holder payment while globally frozen", async () => {
    await submitAndAssertSuccess(client, walletA, {
      TransactionType: "Payment",
      Account: walletA.address,
      Destination: walletC.address,
      Amount: { mpt_issuance_id: issuanceId, value: "1" },
    });
  });
  await issuer.unfreezeGlobal();
  assert.equal((await issuer.getIssuanceState()).globallyLocked, false);
  console.log("  token globally frozen then unfrozen; not globally frozen now");

  log("Ban holder C: claw back full balance, then revoke allowlist approval");
  await issuer.banHolder(walletC.address);
  const cAfterBan = await issuer.getHolderState(walletC.address);
  assert.equal(cAfterBan?.balance, "0");
  assert.equal(cAfterBan?.authorized, false);
  await expectFailure("payment to banned holder C", async () => {
    await issuer.send(walletC.address, 1);
  });
  console.log("  C holds 0 tokens and cannot receive the token again");

  log("Final state verification");
  const finalA = await issuer.getHolderState(walletA.address);
  const finalB = await issuer.getHolderState(walletB.address);
  const finalC = await issuer.getHolderState(walletC.address);
  const finalIssuance = await issuer.getIssuanceState();

  assert.equal(finalA?.balance, "500");
  assert.equal(finalA?.individuallyLocked, false);
  assert.equal(finalB?.balance, "700");
  assert.equal(finalB?.individuallyLocked, true);
  assert.equal(finalC?.balance, "0");
  assert.equal(finalC?.authorized, false);
  assert.equal(finalIssuance.globallyLocked, false);

  console.log("Final holder A:", finalA);
  console.log("Final holder B:", finalB);
  console.log("Final holder C:", finalC);
  console.log("Final issuance:", finalIssuance);

  const result = {
    issuanceId,
    holders: {
      A: walletA.address,
      B: walletB.address,
      C: walletC.address,
    },
  };
  const outPath = path.join(__dirname, "..", "result.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`\nWrote ${outPath}`);

  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
