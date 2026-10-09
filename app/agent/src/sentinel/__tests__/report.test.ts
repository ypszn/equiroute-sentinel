/**
 * Sentinel report: determinism, preservation, and classification.
 *
 * Covers required cases 1 (valid NVDA intent), 2 (invalid ticker/input),
 * 6 (selected route preserved exactly), 7 (alternatives preserved),
 * 8 (blocked → blocked), 9 (confirmation_required → needs_confirmation),
 * 10 (allowed → actionable), 11 (no route → unavailable),
 * 12 (rejection reasons preserved), 14 (authorization always none) and
 * 15 (requiresUserReviewInEquiRoute always true).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EquiRouteError } from "../equirouteClient.js";
import { CANONICAL_QUOTE_CONTEXT_ADDRESS } from "../config.js";
import { createSentinelRunner } from "../runner.js";
import { validateSentinelIntent } from "../intent.js";
import type { SentinelReport } from "../types.js";
import {
  BSTOCK_ADDRESS,
  BSTOCK_OUTPUT,
  BSTOCK_SHARES,
  BSTOCK_USD_PER_SHARE,
  NVDA_INTENT,
  ONDO_FAILURE_REASON,
  PREMARKET_CONFIRMATION_REASON,
  policyAllowedFixture,
  policyBlockedFixture,
  policyFixture,
  policyNoRouteFixture,
  policyUnsupportedTickerFixture,
  routeFixture,
  routeNoRouteFixture,
  routeUnsupportedTickerFixture,
  XSTOCK_FAILURE_REASON,
} from "./fixtures.js";
import { fakeClient, FIXED_NOW, fixedClock } from "./helpers.js";

function runner(options: Parameters<typeof fakeClient>[0]) {
  return createSentinelRunner({
    client: fakeClient(options),
    model: null,
    clock: fixedClock,
  });
}

/** The two invariants that must hold on EVERY report the Sentinel emits. */
function assertExecutionBoundary(report: SentinelReport): void {
  assert.equal(report.execution.authorization, "none");
  assert.equal(report.execution.requiresUserReviewInEquiRoute, true);
}

// ── 1. Valid NVDA intent ────────────────────────────────────────────────────

test("1. a valid NVDA intent produces a complete structured report", async () => {
  const sentinel = runner({ route: routeFixture(), policy: policyFixture() });
  const { report, explanation } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.version, "1");
  assert.equal(report.generatedAt, FIXED_NOW);
  assert.deepEqual(report.intent, {
    ticker: "NVDA",
    notionalUsd: "10",
    slippagePercent: "0.5",
  });
  assert.equal(report.market.regime, "premarket");
  assert.equal(report.market.available, true);
  assert.equal(report.selectedRepresentation?.symbol, "NVDAB");
  assert.equal(report.policy.outcome, "confirmation_required");
  assert.equal(report.opportunity.status, "needs_confirmation");
  assert.equal(report.quoteContext.addressUsed, "0x30B146dF82aDB5e32155ea1bA94d016bf95bF2D5");
  assert.equal(report.quoteContext.purpose, "read_only_quote_context");
  assert.equal(report.quoteContext.executionAuthority, false);
  assert.equal(report.comparison.status, "degraded");
  assert.deepEqual(report.comparison.degradedBy, [
    "ondo/NVDAon: QUOTE_CONTEXT_ADDRESS_REQUIRED",
    "xstock/NVDAx: QUOTE_CONTEXT_ADDRESS_REQUIRED",
  ]);
  assertExecutionBoundary(report);

  assert.match(explanation, /NVDA Market Sentinel/);
  assert.match(explanation, /No transaction has been authorized or executed\./);
});

test("1. both EquiRoute passes are called with the validated intent", async () => {
  const client = fakeClient({ route: routeFixture(), policy: policyFixture() });
  const sentinel = createSentinelRunner({ client, model: null, clock: fixedClock });
  await sentinel.analyze({ ticker: "nvda", notionalUsd: 10, slippagePercent: "0.5" });

  assert.equal(client.routeCalls.length, 1);
  assert.equal(client.policyCalls.length, 1);
  // Normalised by fixed code before any network call.
  assert.equal(client.routeCalls[0]?.ticker, "NVDA");
  assert.equal(client.policyCalls[0]?.notionalUsd, "10");
  assert.equal(client.policyCalls[0]?.slippagePercent, "0.5");
});

test("1. an optional mandate is forwarded to EquiRoute verbatim", async () => {
  const client = fakeClient({ route: routeFixture(), policy: policyFixture() });
  const sentinel = createSentinelRunner({ client, model: null, clock: fixedClock });
  const mandate = { version: 1, execution: { requireHumanConfirmation: false } };
  await sentinel.analyze({ ...NVDA_INTENT, mandate });

  assert.deepEqual(client.policyCalls[0]?.mandate, mandate);
});

// ── 2. Invalid ticker / input ───────────────────────────────────────────────

test("2. invalid input is rejected by fixed code before any EquiRoute call", async () => {
  const cases: Array<[string, unknown]> = [
    ["empty ticker", { ticker: "", notionalUsd: "10" }],
    ["missing ticker", { notionalUsd: "10" }],
    ["non-string ticker", { ticker: 42, notionalUsd: "10" }],
    ["junk ticker", { ticker: "not a ticker!", notionalUsd: "10" }],
    ["missing notional", { ticker: "NVDA" }],
    ["non-decimal notional", { ticker: "NVDA", notionalUsd: "ten" }],
    ["zero notional", { ticker: "NVDA", notionalUsd: "0" }],
    ["negative notional", { ticker: "NVDA", notionalUsd: "-10" }],
    ["exponent notional", { ticker: "NVDA", notionalUsd: "1e21" }],
    ["zero slippage", { ticker: "NVDA", notionalUsd: "10", slippagePercent: "0" }],
    ["absurd slippage", { ticker: "NVDA", notionalUsd: "10", slippagePercent: "99" }],
    ["array payload", []],
    ["null payload", null],
  ];

  for (const [label, payload] of cases) {
    const client = fakeClient({ route: routeFixture(), policy: policyFixture() });
    const sentinel = createSentinelRunner({ client, model: null, clock: fixedClock });
    const { report } = await sentinel.analyze(payload);

    assert.equal(report.opportunity.status, "unavailable", label);
    assert.equal(report.policy.outcome, "unavailable", label);
    assert.equal(report.selectedRepresentation, null, label);
    assert.deepEqual(report.alternatives, [], label);
    assert.match(report.opportunity.reason, /Invalid Sentinel request/, label);
    assertExecutionBoundary(report);
    // No EquiRoute quota is spent on invalid input.
    assert.equal(client.routeCalls.length, 0, label);
    assert.equal(client.policyCalls.length, 0, label);
  }
});

test("2. a valid-but-unsupported ticker is EquiRoute's call, not ours", async () => {
  // Syntactically fine, so it reaches EquiRoute, which reports it unsupported.
  const sentinel = runner({
    route: routeUnsupportedTickerFixture("TSLA"),
    policy: policyUnsupportedTickerFixture("TSLA"),
  });
  const { report } = await sentinel.analyze({ ticker: "TSLA", notionalUsd: "10" });

  assert.equal(report.selectedRepresentation, null);
  // EquiRoute returns no policyDecision for an unsupported ticker — the
  // Sentinel must not infer one.
  assert.equal(report.policy.outcome, "unavailable");
  assert.equal(report.opportunity.status, "unavailable");
  assert.ok(
    report.warnings.some((w) => w.includes("Unsupported ticker: TSLA")),
    "the upstream rejection reason is preserved",
  );
  assertExecutionBoundary(report);
});

test("2. validateSentinelIntent reports the offending field", () => {
  assert.throws(
    () => validateSentinelIntent({ ticker: "NVDA", notionalUsd: "abc" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { field?: string }).field, "notionalUsd");
      return true;
    },
  );
  // Default slippage matches EquiRoute's own default.
  assert.equal(
    validateSentinelIntent({ ticker: "NVDA", notionalUsd: "10" }).slippagePercent,
    "0.5",
  );
});

// ── 6. Selected route preserved exactly ─────────────────────────────────────

test("6. the selected representation is copied verbatim from EquiRoute", async () => {
  const policy = policyFixture();
  const sentinel = runner({ route: routeFixture(), policy });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  const selected = report.selectedRepresentation;
  assert.ok(selected !== null);
  assert.deepEqual(selected, {
    provider: "bstock",
    symbol: "NVDAB",
    contractAddress: BSTOCK_ADDRESS,
    executionMode: "SWAP",
    expectedOutput: BSTOCK_OUTPUT,
    normalizedUnderlyingShares: BSTOCK_SHARES,
    effectiveUsdPerShare: BSTOCK_USD_PER_SHARE,
  });

  // Byte-for-byte identical to the EquiRoute quote — no rounding, no reformat.
  const source = policy.selected;
  assert.equal(selected.contractAddress, source?.contractAddress);
  assert.equal(selected.expectedOutput, source?.outputTokenAmount);
  assert.equal(selected.normalizedUnderlyingShares, source?.estimatedUnderlyingShares);
  assert.equal(selected.effectiveUsdPerShare, source?.effectiveUsdPerShare);
});

test("6. the Sentinel never reranks: a different EquiRoute winner is honoured", async () => {
  // EquiRoute hands back the WORST-looking quote as the winner. The Sentinel
  // must report it anyway — it is not allowed to re-select.
  const policy = policyFixture();
  const ondo = policy.quotes.find((q) => q.provider === "ondo");
  assert.ok(ondo !== undefined);
  ondo.available = true;
  ondo.failureCode = null;
  ondo.failureReason = null;
  ondo.estimatedUnderlyingShares = "0.0100000000";
  ondo.effectiveUsdPerShare = "999.999999";
  policy.selected = ondo;
  policy.policyRejectedRoutes = [];

  const sentinel = runner({ route: routeFixture(), policy });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.selectedRepresentation?.provider, "ondo");
  assert.equal(report.selectedRepresentation?.effectiveUsdPerShare, "999.999999");
  // The objectively better bstock quote appears only as an alternative.
  const bstock = report.alternatives.find((a) => a.provider === "bstock");
  assert.equal(bstock?.eligible, true);
  assert.equal(bstock?.effectiveUsdPerShare, BSTOCK_USD_PER_SHARE);
});

// ── 7. Alternatives preserved ───────────────────────────────────────────────

test("7. every non-selected representation is reported as an alternative", async () => {
  const sentinel = runner({ route: routeFixture(), policy: policyFixture() });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.alternatives.length, 2);
  assert.deepEqual(
    report.alternatives.map((a) => `${a.provider}/${a.symbol}`).sort(),
    ["ondo/NVDAon", "xstock/NVDAx"],
  );
  // The selected representation is not duplicated into the alternatives.
  assert.equal(
    report.alternatives.some((a) => a.symbol === "NVDAB"),
    false,
  );
  for (const alternative of report.alternatives) {
    assert.equal(alternative.eligible, false);
    assert.equal(typeof alternative.rejectionReason, "string");
  }
});

test("7. an eligible alternative keeps its EquiRoute numbers", async () => {
  const policy = policyFixture();
  const xstock = policy.quotes.find((q) => q.provider === "xstock");
  assert.ok(xstock !== undefined);
  xstock.available = true;
  xstock.failureCode = null;
  xstock.failureReason = null;
  xstock.estimatedUnderlyingShares = "0.0421000000";
  xstock.effectiveUsdPerShare = "237.500000";
  policy.policyRejectedRoutes = [];

  const route = routeFixture();
  const routeXstock = route.quotes.find((q) => q.provider === "xstock");
  assert.ok(routeXstock !== undefined);
  routeXstock.available = true;
  routeXstock.failureCode = null;
  routeXstock.failureReason = null;
  route.rejected = [];

  const sentinel = runner({ route, policy });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  const alternative = report.alternatives.find((a) => a.provider === "xstock");
  assert.equal(alternative?.eligible, true);
  assert.equal(alternative?.normalizedUnderlyingShares, "0.0421000000");
  assert.equal(alternative?.effectiveUsdPerShare, "237.500000");
  assert.equal(alternative?.rejectionReason, undefined);
});

test("quote-context failures degrade analysis without counting as comparable", async () => {
  const sentinel = runner({ route: routeFixture(), policy: policyFixture() });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });
  const ondo = report.alternatives.find((a) => a.provider === "ondo");
  assert.equal(ondo?.rejectionClass, "QUOTE_CONTEXT_ADDRESS_REQUIRED");
  assert.equal(report.comparison.status, "degraded");
  assert.equal(report.comparison.economicallyComparableRepresentations, 1);
  assert.equal(report.comparison.unavailableRepresentations, 2);
  assert.match(report.comparison.degradedBy[0] ?? "", /QUOTE_CONTEXT_ADDRESS_REQUIRED/);
  assert.equal(report.opportunity.status, "needs_confirmation");
});

test("genuine liquidity failure stays a liquidity failure and comparison remains complete", async () => {
  const route = routeFixture();
  const policy = policyFixture();
  const xstockRoute = route.quotes.find((quote) => quote.provider === "xstock");
  const xstockPolicy = policy.quotes.find((quote) => quote.provider === "xstock");
  assert.ok(xstockRoute && xstockPolicy);
  xstockRoute.failureCode = "40374";
  xstockRoute.failureReason = "Insufficient liquidity for a quote. Please decrease the transaction amount or try again later.";
  xstockPolicy.failureCode = "40374";
  xstockPolicy.failureReason = xstockRoute.failureReason;
  // Remove the quote-context requirement from the other RFQ fixture: with a
  // configured address, it should not be misclassified as a missing-context
  // degradation.
  for (const quotes of [route.quotes, policy.quotes]) {
    const ondo = quotes.find((quote) => quote.provider === "ondo");
    assert.ok(ondo);
    ondo.available = true;
    ondo.failureCode = null;
    ondo.failureReason = null;
    ondo.estimatedUnderlyingShares = "0.0423558948";
    ondo.effectiveUsdPerShare = "236.094645";
  }
  route.rejected = route.rejected.filter((entry) => entry.provider !== "ondo");
  const sentinel = runner({ route, policy });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });
  const xstock = report.alternatives.find((a) => a.provider === "xstock");
  assert.equal(xstock?.rejectionClass, "NO_EXECUTABLE_LIQUIDITY");
  assert.equal(report.comparison.status, "complete");
  assert.deepEqual(report.comparison.degradedBy, []);
});



test("12. rejection reasons and codes are preserved exactly", async () => {
  const sentinel = runner({ route: routeFixture(), policy: policyFixture() });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  const ondo = report.alternatives.find((a) => a.provider === "ondo");
  // The TRUE quote-level cause wins over the coarse mandate reason that
  // /api/policy/evaluate reports for an unquotable route.
  assert.equal(ondo?.rejectionReason, ONDO_FAILURE_REASON);
  assert.equal(ondo?.rejectionCode, "40001");
  assert.notEqual(ondo?.rejectionReason, "Route violates active mandate");

  const xstock = report.alternatives.find((a) => a.provider === "xstock");
  assert.equal(xstock?.rejectionReason, XSTOCK_FAILURE_REASON);
  assert.equal(xstock?.rejectionCode, "40001");
});

test("12. a mandate-only rejection keeps EquiRoute's policy reason and stage", async () => {
  // Quote succeeded upstream; only the mandate rejected it.
  const policy = policyFixture();
  const xstock = policy.quotes.find((q) => q.provider === "xstock");
  assert.ok(xstock !== undefined);
  xstock.available = true;
  xstock.failureCode = null;
  xstock.failureReason = null;

  const route = routeFixture();
  const routeXstock = route.quotes.find((q) => q.provider === "xstock");
  assert.ok(routeXstock !== undefined);
  routeXstock.available = true;
  routeXstock.failureCode = null;
  routeXstock.failureReason = null;
  route.rejected = route.rejected.filter((r) => r.provider !== "xstock");

  const sentinel = runner({ route, policy });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  const alternative = report.alternatives.find((a) => a.provider === "xstock");
  assert.equal(alternative?.eligible, false);
  assert.equal(alternative?.rejectionReason, "Wrapper ratio is unverified");
  assert.equal(alternative?.rejectionCode, "UNVERIFIED_WRAPPER_RATIO");
  assert.equal(alternative?.rejectionStage, "representation");
});

// ── 8/9/10/11. Opportunity classification ───────────────────────────────────

test("9. confirmation_required maps to needs_confirmation", async () => {
  const sentinel = runner({ route: routeFixture(), policy: policyFixture() });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.policy.outcome, "confirmation_required");
  assert.deepEqual(report.policy.confirmationReasons, [PREMARKET_CONFIRMATION_REASON]);
  assert.deepEqual(report.policy.blockingReasons, []);
  assert.equal(report.opportunity.status, "needs_confirmation");
  assert.match(report.opportunity.reason, /premarket/);
  assertExecutionBoundary(report);
});

test("10. allowed maps to actionable", async () => {
  const sentinel = runner({ route: routeFixture(), policy: policyAllowedFixture() });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.policy.outcome, "allowed");
  assert.equal(report.opportunity.status, "actionable");
  // Even an actionable opportunity authorizes nothing.
  assertExecutionBoundary(report);
  assert.match(report.opportunity.reason, /Review it in EquiRoute/);
});

test("8. blocked maps to blocked and keeps the blocking reasons", async () => {
  const sentinel = runner({ route: routeFixture(), policy: policyBlockedFixture() });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.policy.outcome, "blocked");
  assert.deepEqual(report.policy.blockingReasons, [
    "Market regime closed is not allowed",
  ]);
  assert.equal(report.opportunity.status, "blocked");
  assert.match(report.opportunity.reason, /Market regime closed is not allowed/);
  assertExecutionBoundary(report);
});

test("11. no selected route maps to unavailable", async () => {
  const sentinel = runner({
    route: routeNoRouteFixture(),
    policy: policyNoRouteFixture(),
  });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.selectedRepresentation, null);
  // The policy pass still returned a non-blocking decision...
  assert.equal(report.policy.outcome, "confirmation_required");
  // ...but with nothing selected there is no opportunity to act on.
  assert.equal(report.opportunity.status, "unavailable");
  assert.match(report.opportunity.reason, /selected no executable representation/);
  // Alternatives and their reasons survive.
  assert.equal(report.alternatives.length, 2);
  assert.equal(
    report.alternatives.find((a) => a.provider === "ondo")?.rejectionReason,
    ONDO_FAILURE_REASON,
  );
  assertExecutionBoundary(report);
});

// ── EquiRoute unavailable must never become an opportunity ──────────────────

test("an unavailable EquiRoute never produces a fabricated opportunity", async () => {
  const sentinel = runner({
    routeError: new EquiRouteError("unreachable", "/api/route", "ECONNREFUSED"),
    policyError: new EquiRouteError("unreachable", "/api/policy/evaluate", "ECONNREFUSED"),
  });
  const { report, explanation } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.selectedRepresentation, null);
  assert.deepEqual(report.alternatives, []);
  assert.equal(report.market.regime, null);
  assert.equal(report.market.available, false);
  assert.equal(report.policy.outcome, "unavailable");
  assert.deepEqual(report.policy.blockingReasons, []);
  assert.equal(report.opportunity.status, "unavailable");
  assert.match(report.opportunity.reason, /unreachable/i);
  assertExecutionBoundary(report);
  assert.match(explanation, /No transaction has been authorized or executed\./);
});

test("a partial EquiRoute failure degrades honestly and is flagged", async () => {
  // Route discovery failed; the mandate-aware pass succeeded.
  const sentinel = runner({
    routeError: new EquiRouteError("http_error", "/api/route", "HTTP 502", {
      status: 502,
      upstreamError: "Routing failed upstream.",
    }),
    policy: policyFixture(),
  });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.policy.outcome, "confirmation_required");
  assert.equal(report.selectedRepresentation?.symbol, "NVDAB");
  assert.ok(report.warnings.some((w) => w.includes("route discovery")));
  // The quote objects in the policy pass still carry the upstream cause, so
  // the true reason survives even without route discovery.
  assert.equal(
    report.alternatives.find((a) => a.provider === "ondo")?.rejectionReason,
    ONDO_FAILURE_REASON,
  );
  assertExecutionBoundary(report);
});

test("a policy-only failure never yields a mandate-checked opportunity", async () => {
  // Route discovery succeeded, mandate evaluation did not. The unconstrained
  // winner may be reported, but it is flagged and the opportunity is NOT
  // presented as compliant.
  const sentinel = runner({
    route: routeFixture(),
    policyError: new EquiRouteError("timeout", "/api/policy/evaluate", "slow"),
  });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.policy.outcome, "unavailable");
  assert.equal(report.opportunity.status, "unavailable");
  assert.ok(
    report.warnings.some((w) => w.includes("mandate was NOT evaluated")),
    "the un-evaluated mandate must be stated",
  );
  assertExecutionBoundary(report);
});

test("market data unavailable is reported, never invented", async () => {
  const policy = policyFixture();
  policy.marketContext = {
    regime: "unknown",
    marketStatus: null,
    openState: null,
    reasonCode: "REQUEST_FAILED",
    reasonMsg: null,
    raw: null,
  };
  policy.policyDecision = {
    outcome: "blocked",
    checks: [],
    blockingReasons: ["Market regime unknown is not allowed"],
    confirmationReasons: [],
  };
  policy.selected = null;

  const route = routeFixture();
  route.marketContext = policy.marketContext;

  const sentinel = runner({ route, policy });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.market.regime, "unknown");
  assert.equal(report.market.available, true);
  assert.ok(report.warnings.some((w) => w.includes("market data unavailable")));
  assert.equal(report.opportunity.status, "blocked");
  assertExecutionBoundary(report);
});

test("a transient quote failure is not misattributed to the mandate", async () => {
  // Route discovery quoted a winner; the mandate pass quoted none and raised
  // no blocking reason. That is an upstream hiccup, not a policy rejection.
  const policy = policyNoRouteFixture();
  const sentinel = runner({ route: routeFixture(), policy });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(report.selectedRepresentation, null);
  assert.deepEqual(report.policy.blockingReasons, []);
  assert.equal(report.opportunity.status, "unavailable");
  assert.ok(
    report.warnings.some(
      (w) =>
        w.includes("bstock/NVDAB") &&
        w.includes("transient upstream quote failure"),
    ),
    `warnings were ${JSON.stringify(report.warnings)}`,
  );
  assertExecutionBoundary(report);
});

test("the passes are called sequentially, not concurrently", async () => {
  // Each EquiRoute pass fans out one live quote per representation; running
  // them at once doubles upstream pressure for a single intent.
  const active: string[] = [];
  let maxConcurrent = 0;
  const track = async <T>(label: string, value: T): Promise<T> => {
    active.push(label);
    maxConcurrent = Math.max(maxConcurrent, active.length);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active.splice(active.indexOf(label), 1);
    return value;
  };

  const sentinel = createSentinelRunner({
    client: {
      getRoute: () => track("route", routeFixture()),
      evaluatePolicy: () => track("policy", policyFixture()),
      quoteContextAddress: () => CANONICAL_QUOTE_CONTEXT_ADDRESS,
    },
    model: null,
    clock: fixedClock,
  });
  await sentinel.analyze({ ...NVDA_INTENT });

  assert.equal(maxConcurrent, 1, "only one EquiRoute pass may be in flight");
});

// ── 14 + 15. Execution boundary on every path ───────────────────────────────

test("14+15. authorization is none and review is required on every path", async () => {
  const scenarios: Array<[string, ReturnType<typeof runner>, unknown]> = [
    [
      "happy path",
      runner({ route: routeFixture(), policy: policyFixture() }),
      { ...NVDA_INTENT },
    ],
    [
      "allowed",
      runner({ route: routeFixture(), policy: policyAllowedFixture() }),
      { ...NVDA_INTENT },
    ],
    [
      "blocked",
      runner({ route: routeFixture(), policy: policyBlockedFixture() }),
      { ...NVDA_INTENT },
    ],
    [
      "no route",
      runner({ route: routeNoRouteFixture(), policy: policyNoRouteFixture() }),
      { ...NVDA_INTENT },
    ],
    [
      "unsupported ticker",
      runner({
        route: routeUnsupportedTickerFixture("TSLA"),
        policy: policyUnsupportedTickerFixture("TSLA"),
      }),
      { ticker: "TSLA", notionalUsd: "10" },
    ],
    [
      "equiroute down",
      runner({
        routeError: new EquiRouteError("unreachable", "/api/route", "down"),
        policyError: new EquiRouteError("unreachable", "/api/policy/evaluate", "down"),
      }),
      { ...NVDA_INTENT },
    ],
    [
      "invalid input",
      runner({ route: routeFixture(), policy: policyFixture() }),
      { ticker: "", notionalUsd: "nope" },
    ],
  ];

  for (const [label, sentinel, payload] of scenarios) {
    const { report, explanation } = await sentinel.analyze(payload);
    assert.equal(report.execution.authorization, "none", label);
    assert.equal(report.execution.requiresUserReviewInEquiRoute, true, label);
    // The invariant is also visible to a human reader.
    assert.match(explanation, /No transaction has been authorized or executed\./, label);
    // Nothing executable is ever emitted.
    const serialized = JSON.stringify(report);
    for (const forbidden of ["rawTransaction", "signedTransaction", "calldata", "txHash"]) {
      assert.equal(serialized.includes(forbidden), false, `${label}: ${forbidden}`);
    }
  }
});

test("the report type pins authorization to the literal 'none'", async () => {
  const sentinel = runner({ route: routeFixture(), policy: policyFixture() });
  const { report } = await sentinel.analyze({ ...NVDA_INTENT });
  // Compile-time: these literal types cannot be widened.
  const authorization: "none" = report.execution.authorization;
  const requiresReview: true = report.execution.requiresUserReviewInEquiRoute;
  assert.equal(authorization, "none");
  assert.equal(requiresReview, true);
});
