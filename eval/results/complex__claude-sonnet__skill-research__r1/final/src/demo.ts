import { writeFileSync } from "node:fs";
import path from "node:path";
import { Client, Wallet } from "xrpl";
import { MptIssuer, MptIssuerError } from "./mptIssuer";

const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const ISSUER_SEED = "<TESTNET_SEED_REDACTED>";

function log(step: string, detail?: unknown): void {
  const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  console.log(`[demo] ${step}${suffix}`);
}

/** Runs `fn` and confirms it fails as expected (used to prove enforcement of a control). Rethrows on unexpected success. */
async function expectFailure(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const detail = err instanceof MptIssuerError ? err.engineResult ?? err.message : String(err);
    log(`OK (blocked as expected): ${label}`, detail);
    return;
  }
  throw new Error(`Expected "${label}" to fail, but it succeeded`);
}

async function main(): Promise<void> {
  const client = new Client(TESTNET_URL);
  await client.connect();
  log("connected to testnet");

  const issuerWallet = Wallet.fromSeed(ISSUER_SEED);
  log("issuer", issuerWallet.address);

  const issuer = new MptIssuer(client, issuerWallet, { assetScale: 2 });

  const { issuanceId } = await issuer.createIssuance({
    maximumAmount: "1000000000",
    metadata: {
      ticker: "RUSD",
      name: "Regulated Stablecoin Demo",
      desc: "Testnet demo of a KYC-gated, clawback-and-freeze-enabled MPT stablecoin",
      icon: "https://example.com/rusd-icon.png",
      asset_class: "rwa",
      asset_subclass: "stablecoin",
      issuer_name: "Demo Compliance Issuer",
    },
  });
  log("created MPT issuance", issuanceId);

  // --- Create and fund three holder accounts -----------------------------
  const { wallet: walletA } = await client.fundWallet();
  const { wallet: walletB } = await client.fundWallet();
  const { wallet: walletC } = await client.fundWallet();
  log("funded holder A", walletA.address);
  log("funded holder B", walletB.address);
  log("funded holder C", walletC.address);

  // --- Holders opt in, issuer allowlists them (KYC approval) -------------
  for (const [label, wallet] of [
    ["A", walletA],
    ["B", walletB],
    ["C", walletC],
  ] as const) {
    await issuer.optInHolder(wallet);
    await issuer.approveHolder(wallet.address);
    log(`holder ${label} opted in and approved`, wallet.address);
  }

  // --- Issue tokens --------------------------------------------------------
  await issuer.sendTokens(walletA.address, "500");
  log("sent 500 to A");
  await issuer.sendTokens(walletB.address, "1000");
  log("sent 1000 to B");
  await issuer.sendTokens(walletC.address, "200");
  log("sent 200 to C");

  // --- Per-holder freeze: freeze A, prove it's blocked, then unfreeze ----
  await issuer.freezeHolder(walletA.address);
  log("froze holder A");
  await expectFailure("payment to frozen holder A", () =>
    issuer.sendTokens(walletA.address, "10"),
  );
  await issuer.unfreezeHolder(walletA.address);
  log("unfroze holder A");

  // --- Clawback: take 300 back from B, then leave B frozen ----------------
  await issuer.clawback(walletB.address, "300");
  log("clawed back 300 from B");
  await issuer.freezeHolder(walletB.address);
  log("froze holder B (left frozen)");

  // --- Ban C: clawback remaining balance, lock, and deauthorize ----------
  const { clawedBack } = await issuer.banHolder(walletC.address);
  log("banned holder C", { clawedBack });
  await expectFailure("payment to banned holder C", () =>
    issuer.sendTokens(walletC.address, "1"),
  );

  // --- Global freeze: halt all movement, prove it, then lift it ----------
  await issuer.freezeGlobal();
  log("applied global freeze");
  await expectFailure("payment while globally frozen", () =>
    issuer.sendTokens(walletA.address, "1"),
  );
  await issuer.unfreezeGlobal();
  log("lifted global freeze");

  // --- Verify final ledger state matches the required end state ----------
  const [stateA, stateB, stateC, globallyFrozen] = await Promise.all([
    issuer.getHolderState(walletA.address),
    issuer.getHolderState(walletB.address),
    issuer.getHolderState(walletC.address),
    issuer.isGloballyFrozen(),
  ]);

  const checks: Array<[string, boolean]> = [
    ["A balance == 500", stateA?.balance === "500"],
    ["A not frozen", stateA?.frozen === false],
    ["B balance == 700", stateB?.balance === "700"],
    ["B frozen", stateB?.frozen === true],
    ["C balance == 0", stateC?.balance === "0"],
    ["C not authorized (banned)", stateC?.authorized === false],
    ["issuance not globally frozen", globallyFrozen === false],
  ];
  for (const [label, ok] of checks) {
    log(`${ok ? "PASS" : "FAIL"}: ${label}`);
    if (!ok) throw new Error(`Final-state check failed: ${label}`);
  }

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
  log("wrote result.json", outPath);

  await client.disconnect();
  log("done");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
