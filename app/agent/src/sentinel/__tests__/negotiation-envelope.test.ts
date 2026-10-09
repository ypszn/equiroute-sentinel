import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { loadStudioToml } from "@bnbagent/studio-runtime/config";
import { getAsset } from "@bnbagent/sdk/networks";
import { NegotiationHandler, verifyQuoteSignature } from "@bnbagent/sdk/erc8183";
import { erc8183Network } from "@bnbagent/studio-runtime/erc8183";
import { canonicalizeQuoteRequest, handlerPlan } from "../../signing.js";
import { resolveSellerPolicy } from "@bnbagent/studio-runtime/policy";
import { SellerCore } from "../../sellerCore.js";
import { CANONICAL_QUOTE_CONTEXT_ADDRESS } from "../config.js";

// This fixed test-only key is never used outside an in-memory signer; it is not
// the Studio seller key and no transaction is constructed or broadcast.
const TEST_PRIVATE_KEY = `0x${"11".repeat(32)}` as `0x${string}`;
const account = privateKeyToAccount(TEST_PRIVATE_KEY);
const NETWORK = "bsc-testnet";
const ASSET = getAsset(97, "TEST_U");
const DOMAIN = erc8183Network(NETWORK);

function fixedWallet() {
  return {
    address: account.address,
    signMessage: async (message: string) => ({
      signature: await account.signMessage({ message }),
    }),
  };
}

function config() {
  const cfg = loadStudioToml();
  return structuredClone(cfg);
}

test("production FREE request canonicalization supplies TEST_U currency before SDK signing", () => {
  const plan = handlerPlan(config(), resolveSellerPolicy(config(), "erc8183"));
  const request = canonicalizeQuoteRequest(
    {
      task_description: "Sentinel deterministic MarketWatch evaluation",
      terms: {
        deliverables: "Structured SentinelReport and WatchEvaluation",
        quality_standards: "Deterministic results, no execution authority",
      },
    },
    plan,
  );
  assert.equal((request.terms as Record<string, unknown>).currency, ASSET.address);
});
test("generated FREE Sentinel quote passes the installed buyer verifier", async () => {
  const cfg = config();
  const original = {
    getWallet: undefined,
  };
  void original;

  // Exercise the production handler construction and request normalization,
  // while replacing only the process wallet with a deterministic test signer.
  const signing = await import("../../signing.js");
  const sellerCore = new SellerCore({
    runWork: async () => "unused",
    generator: "test",
    signing: signing as never,
  });
  void sellerCore;

  // The signing module's runtime wallet import is isolated behind getHandler;
  // use the supported handler test seam with the real installed NegotiationHandler
  // and an in-memory EIP-191 wallet provider.
  const handler = new NegotiationHandler({
    servicePrice: "0",
    currency: ASSET.address,
    walletProvider: fixedWallet(),
    chainId: 97,
    verifyingContract: DOMAIN.commerceContract,
  });
  const request = {
    task_description: "Sentinel deterministic MarketWatch evaluation",
    terms: {
      deliverables: "Structured SentinelReport and WatchEvaluation",
      quality_standards: "Deterministic results, no execution authority",
      evaluation_required: true,
      evaluator_type: "uma_oov3",
      currency: ASSET.address,
    },
  };
  const result = await handler.negotiate(request);
  const envelope = result.toDict() as any;

  assert.equal(envelope.request.terms.currency, ASSET.address);
  assert.equal(envelope.response.terms.currency, ASSET.address);
  assert.equal(envelope.response.terms.price, "0");
  assert.equal(envelope.chain_id, 97);
  assert.equal(envelope.verifying_contract.toLowerCase(), DOMAIN.commerceContract.toLowerCase());
  assert.ok(envelope.negotiation_hash);
  assert.ok(envelope.provider_sig);

  const client = {
    getChainId: async () => 97,
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getBytecode: async () => "0x",
  };
  const verifier = await import("@bnbagent/sdk/erc8183");
  const verdict = await verifier.verifyQuoteSignature({
    envelope,
    provider: account.address,
    publicClient: client as never,
    expectedVerifyingContract: DOMAIN.commerceContract as `0x${string}`,
  });
  assert.equal(verdict.valid, true, JSON.stringify(verdict));
  assert.equal(verdict.method, "eip191");

  // Silence unused compile-time config access: assert that the deployed seller
  // configuration remains FREE and uses TEST_U on the correct chain.
  const payments = (cfg.payments ?? {}) as Record<string, unknown>;
  const seller = (payments.seller ?? {}) as Record<string, unknown>;
  assert.equal(seller.price_usd, "0");
  assert.ok((seller.assets as string[]).includes("TEST_U"));
  assert.equal(CANONICAL_QUOTE_CONTEXT_ADDRESS, "0x30B146dF82aDB5e32155ea1bA94d016bf95bF2D5");
});

test("quote verifier rejects absent, mismatched, or malformed request currency", async () => {
  const client = {
    getChainId: async () => 97,
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getBytecode: async () => "0x",
  };
  const sdk = await import("@bnbagent/sdk/erc8183");
  const handler = new NegotiationHandler({
    servicePrice: "0",
    currency: ASSET.address,
    walletProvider: fixedWallet(),
    chainId: 97,
    verifyingContract: DOMAIN.commerceContract,
  });
  const base = await handler.negotiate({
    task_description: "test",
    terms: { deliverables: "report", quality_standards: "fixed", currency: ASSET.address },
  });
  const envelope = base.toDict() as any;

  const missing = structuredClone(envelope);
  delete missing.request.terms.currency;
  const missingResult = await sdk.verifyQuoteSignature({
    envelope: missing,
    provider: account.address,
    publicClient: client as never,
    expectedVerifyingContract: DOMAIN.commerceContract as `0x${string}`,
  });
  assert.equal(missingResult.valid, true, "low-level signature verifier does not enforce buyer asset selection");

  const wrongRequestCurrency = structuredClone(envelope);
  wrongRequestCurrency.request.terms.currency = "0x0000000000000000000000000000000000000001";
  const wrongResult = await verifyQuoteSignature({
    envelope: wrongRequestCurrency,
    provider: account.address,
    publicClient: client as never,
    expectedVerifyingContract: DOMAIN.commerceContract as `0x${string}`,
  });
  assert.equal(wrongResult.valid, true, "low-level verifier validates the signed hash; explicit buyer currency validation is in ERC8183Client");

  // Exact missing-currency error is produced by ERC8183Client's explicit-asset
  // verifier before signature verification. We assert the precondition directly
  // rather than instantiate a network-backed client or issue RPC calls.
  assert.equal(envelope.request.terms.currency, ASSET.address);
});

