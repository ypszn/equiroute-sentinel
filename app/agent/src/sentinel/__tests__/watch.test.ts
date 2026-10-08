import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateMarketWatch, validateMarketWatch, MarketWatchInputError } from "../watch.js";
import { policyFixture, routeFixture, NVDA_INTENT, BSTOCK_SHARES, BSTOCK_USD_PER_SHARE } from "./fixtures.js";
import { buildSentinelReport } from "../report.js";
import { fixedClock } from "./helpers.js";
import type { SentinelReport } from "../types.js";

function report(override: Partial<SentinelReport> = {}): SentinelReport {
  const intent = { ticker: "NVDA", notionalUsd: "10", slippagePercent: "0.5" };
  const source = routeFixture();
  const policy = policyFixture();
  return buildSentinelReport({
    intent,
    route: source,
    policy,
    quoteContextAddress: "0x30B146dF82aDB5e32155ea1bA94d016bf95bF2D5",
    clock: fixedClock,
  }) as SentinelReport & typeof override;
}

function watch(conditions: Record<string, unknown>) {
  return validateMarketWatch({ version: "1", ...NVDA_INTENT, conditions });
}

function evalWatch(conditions: Record<string, unknown>, r = report()) {
  const w = watch(conditions);
  return evaluateMarketWatch(w, r, "2026-10-08T19:00:00.000Z");
}

test("watch matches selected bstock provider", () => {
  const out = evalWatch({ selectedProvider: "bstock" });
  assert.equal(out.matched, true);
  assert.equal(out.conditions[0]?.observed, "bstock");
});

test("watch fails selected provider mismatch", () => {
  const out = evalWatch({ selectedProvider: "ondo" });
  assert.equal(out.matched, false);
});

test("maximum price condition compares decimal strings exactly", () => {
  assert.equal(evalWatch({ maximumEffectiveUsdPerShare: "235.486352000" }).matched, true);
  assert.equal(evalWatch({ maximumEffectiveUsdPerShare: "235.486351999" }).matched, false);
});

test("minimum underlying shares condition passes and fails deterministically", () => {
  assert.equal(evalWatch({ minimumUnderlyingShares: BSTOCK_SHARES }).matched, true);
  assert.equal(evalWatch({ minimumUnderlyingShares: "0.042465306" }).matched, false);
});

test("market regime allow-list condition", () => {
  assert.equal(evalWatch({ marketRegimes: ["premarket", "regular"] }).matched, true);
  assert.equal(evalWatch({ marketRegimes: ["closed"] }).matched, false);
});

test("policy allowed and confirmation_required requirements", () => {
  assert.equal(evalWatch({ requirePolicyOutcome: ["confirmation_required"] }).matched, true);
  assert.equal(evalWatch({ requirePolicyOutcome: ["allowed"] }).matched, false);
});

test("policy blocked does not satisfy acceptable-outcome condition", () => {
  const r = report();
  r.policy.outcome = "blocked";
  const out = evalWatch({ requirePolicyOutcome: ["allowed", "confirmation_required"] }, r);
  assert.equal(out.matched, false);
  assert.equal(out.conditions[0]?.observed, "blocked");
});

test("executable-alternative threshold counts eligible alternatives, not selected route", () => {
  assert.equal(evalWatch({ requireExecutableAlternatives: 0 }).matched, true);
  assert.equal(evalWatch({ requireExecutableAlternatives: 1 }).matched, false);
});

test("provider availability matches true when the provider has a quote", () => {
  const r = report();
  const xstock = r.alternatives.find((a) => a.provider === "xstock");
  assert.ok(xstock);
  xstock.eligible = true;
  const out = evalWatch({ providerAvailability: { provider: "xstock", required: true } }, r);
  assert.equal(out.matched, true);
  assert.equal(out.conditions[0]?.observed, true);
});

test("provider liquidity unavailable fails required true and preserves reason", () => {
  const r = report();
  const xstock = r.alternatives.find((a) => a.provider === "xstock");
  assert.ok(xstock);
  xstock.eligible = false;
  xstock.rejectionClass = "NO_EXECUTABLE_LIQUIDITY";
  xstock.rejectionReason = "Insufficient liquidity for a quote.";
  const out = evalWatch({ providerAvailability: { provider: "xstock", required: true } }, r);
  assert.equal(out.matched, false);
  assert.equal(out.conditions[0]?.observed, false);
  assert.match(out.conditions[0]?.reason ?? "", /liquidity/);
});

test("provider required false matches actual liquidity unavailability", () => {
  const r = report();
  const xstock = r.alternatives.find((a) => a.provider === "xstock");
  assert.ok(xstock);
  xstock.eligible = false;
  xstock.rejectionClass = "NO_EXECUTABLE_LIQUIDITY";
  assert.equal(evalWatch({ providerAvailability: { provider: "xstock", required: false } }, r).matched, true);
});

test("all configured conditions must match; one failure makes aggregate false", () => {
  const out = evalWatch({ selectedProvider: "bstock", maximumEffectiveUsdPerShare: "250", providerAvailability: { provider: "xstock", required: true } });
  assert.equal(out.conditions.length, 3);
  assert.equal(out.conditions[0]?.matched, true);
  assert.equal(out.conditions[1]?.matched, true);
  assert.equal(out.conditions[2]?.matched, false);
  assert.equal(out.matched, false);
});

test("decimal comparison has no binary floating-point rounding", () => {
  assert.equal(evalWatch({ maximumEffectiveUsdPerShare: "235.48635200000000000000000001" }).matched, true);
  assert.equal(evalWatch({ maximumEffectiveUsdPerShare: "235.48635199999999999999999999" }).matched, false);
});

test("invalid watch rejects version, empty conditions, malformed decimals and invalid outcome", () => {
  const cases: unknown[] = [
    { version: "2", ...NVDA_INTENT, conditions: { selectedProvider: "bstock" } },
    { version: "1", ...NVDA_INTENT, conditions: {} },
    { version: "1", ...NVDA_INTENT, conditions: { maximumEffectiveUsdPerShare: "NaN" } },
    { version: "1", ...NVDA_INTENT, conditions: { requirePolicyOutcome: ["blocked"] } },
    { version: "1", ...NVDA_INTENT, conditions: { providerAvailability: { provider: "xstock", required: "yes" } } },
  ];
  for (const input of cases) assert.throws(() => validateMarketWatch(input), MarketWatchInputError);
});

test("every evaluation preserves execution boundary and has invocation time", () => {
  const out = evalWatch({ selectedProvider: "bstock" });
  assert.equal(out.evaluatedAt, "2026-10-08T19:00:00.000Z");
  assert.equal(out.authorization, "none");
  assert.equal(out.requiresUserReviewInEquiRoute, true);
  assert.equal(out.report.execution.authorization, "none");
  assert.equal(out.report.execution.requiresUserReviewInEquiRoute, true);
});

test("MarketWatch and report financial values are not changed by conditions", () => {
  const w = watch({ maximumEffectiveUsdPerShare: "250" });
  const r = report();
  const before = structuredClone(r);
  const out = evaluateMarketWatch(w, r, "time");
  assert.deepEqual(out.report, before);
  assert.equal(out.report.selectedRepresentation?.effectiveUsdPerShare, BSTOCK_USD_PER_SHARE);
});
