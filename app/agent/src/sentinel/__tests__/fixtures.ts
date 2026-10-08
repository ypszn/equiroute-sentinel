/**
 * EquiRoute response fixtures.
 *
 * Shapes and values are taken from LIVE responses of the sibling `../equiroute`
 * app (`POST /api/route` and `POST /api/policy/evaluate`, NVDA / $10 / 0.5%),
 * trimmed to the fields the Sentinel reads. Numeric values are kept EXACTLY as
 * EquiRoute emitted them so the "no recalculation" assertions are meaningful.
 */

import type { PolicyResult, RouteResult } from "../types.js";

export const NVDA_INTENT = {
  ticker: "NVDA",
  notionalUsd: "10",
  slippagePercent: "0.5",
} as const;

// ── Live values (do not "tidy" these) ────────────────────────────────────────
export const BSTOCK_SHARES = "0.0424653059";
export const BSTOCK_USD_PER_SHARE = "235.486352";
export const BSTOCK_OUTPUT = "0.042498353480453487";
export const BSTOCK_PRICE_IMPACT = "0.0025053257";
export const BSTOCK_ADDRESS = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
export const ONDO_ADDRESS = "0xa9ee28c80f960b889dfbd1902055218cba016f75";
export const XSTOCK_ADDRESS = "0xc845b2894dbddd03858fd2d643b4ef725fe0849d";

export const ONDO_FAILURE_REASON =
  "userWalletAddress is required for RFQ (Ondo) quote";
export const XSTOCK_FAILURE_REASON =
  "userWalletAddress is required for RFQ (xStock) quote";
export const XSTOCK_POLICY_REASON = "Wrapper ratio is unverified";
export const PREMARKET_CONFIRMATION_REASON =
  "Market is premarket; mandate requires confirmation";

const bstockQuote = {
  provider: "bstock",
  symbol: "NVDAB",
  contractAddress: BSTOCK_ADDRESS,
  available: true,
  executionMode: "SWAP",
  outputTokenAmount: BSTOCK_OUTPUT,
  estimatedUnderlyingShares: BSTOCK_SHARES,
  effectiveUsdPerShare: BSTOCK_USD_PER_SHARE,
  priceImpactPercent: BSTOCK_PRICE_IMPACT,
  ratioStatus: "verified",
  failureCode: null,
  failureReason: null,
  inputAmountUsd: "10",
  latencyMs: 412,
  raw: null,
};

const ondoQuote = {
  provider: "ondo",
  symbol: "NVDAon",
  contractAddress: ONDO_ADDRESS,
  available: false,
  executionMode: null,
  outputTokenAmount: null,
  estimatedUnderlyingShares: null,
  effectiveUsdPerShare: null,
  priceImpactPercent: null,
  ratioStatus: "verified",
  failureCode: "40001",
  failureReason: ONDO_FAILURE_REASON,
  inputAmountUsd: "10",
  latencyMs: 388,
  raw: null,
};

const xstockQuote = {
  provider: "xstock",
  symbol: "NVDAx",
  contractAddress: XSTOCK_ADDRESS,
  available: false,
  executionMode: null,
  outputTokenAmount: null,
  estimatedUnderlyingShares: null,
  effectiveUsdPerShare: null,
  priceImpactPercent: null,
  ratioStatus: "unavailable",
  failureCode: "40001",
  failureReason: XSTOCK_FAILURE_REASON,
  inputAmountUsd: "10",
  latencyMs: 401,
  raw: null,
};

const premarketContext = {
  regime: "premarket",
  marketStatus: "premarket",
  openState: false,
  reasonCode: "TRADING",
  reasonMsg: null,
  referencePrice: "234.702427",
  normalizedRegime: "premarket",
  raw: null,
};

export const DEFAULT_MANDATE = {
  version: 1,
  trade: {
    maxNotionalUsd: "1000",
    maxPriceImpactPercent: "1",
    maxSlippagePercent: "0.5",
  },
  providers: { allowed: null, blocked: [] },
  marketRegime: {
    allowRegular: true,
    allowPremarket: true,
    allowPostmarket: true,
    allowOffhours: true,
    allowClosed: false,
    allowPaused: false,
    allowRestricted: false,
    requireConfirmationOutsideRegular: true,
  },
  verification: {
    requireVerifiedWrapperRatio: true,
    requireCanonicalRepresentation: true,
    requireSimulationSuccess: true,
  },
  execution: { requireHumanConfirmation: true },
} as const;

/** `POST /api/route` 200 for NVDA / $10 (premarket, bstock wins). */
export function routeFixture(): RouteResult {
  return structuredClone({
    intent: { ticker: "NVDA", notionalUsd: "10", userWalletAddress: null },
    marketContext: premarketContext,
    representationsEvaluated: 3,
    quotes: [ondoQuote, bstockQuote, xstockQuote],
    selected: bstockQuote,
    rejected: [
      {
        provider: "ondo",
        symbol: "NVDAon",
        reason: ONDO_FAILURE_REASON,
        code: "40001",
      },
      {
        provider: "xstock",
        symbol: "NVDAx",
        reason: XSTOCK_FAILURE_REASON,
        code: "40001",
      },
    ],
    policyRejectedRoutes: [],
    explanation: [
      `bstock/NVDAB selected after deterministic policy filtering and ranking (${BSTOCK_SHARES} shares for $10).`,
      "Market regime: premarket.",
    ],
  }) as RouteResult;
}

/** `POST /api/policy/evaluate` 200 — confirmation_required (premarket). */
export function policyFixture(): PolicyResult {
  return structuredClone({
    mandate: DEFAULT_MANDATE,
    intent: { ticker: "NVDA", notionalUsd: "10", userWalletAddress: null },
    marketContext: premarketContext,
    quotes: [ondoQuote, bstockQuote, xstockQuote],
    selected: bstockQuote,
    rejected: [],
    policyRejectedRoutes: [
      {
        provider: "ondo",
        symbol: "NVDAon",
        reasonCode: "POLICY_BLOCKED",
        reason: "Route violates active mandate",
        stage: "representation",
      },
      {
        provider: "xstock",
        symbol: "NVDAx",
        reasonCode: "UNVERIFIED_WRAPPER_RATIO",
        reason: XSTOCK_POLICY_REASON,
        stage: "representation",
      },
    ],
    policyDecision: {
      outcome: "confirmation_required",
      checks: [
        {
          id: "market-regime",
          stage: "market",
          status: "confirmation_required",
          reason: PREMARKET_CONFIRMATION_REASON,
        },
      ],
      blockingReasons: [],
      confirmationReasons: [PREMARKET_CONFIRMATION_REASON],
    },
    evaluatedAt: "2026-10-08T12:02:27.248Z",
  }) as PolicyResult;
}

/** Policy pass where the mandate ALLOWED the selected route. */
export function policyAllowedFixture(): PolicyResult {
  const policy = policyFixture();
  policy.policyDecision = {
    outcome: "allowed",
    checks: [
      {
        id: "market-regime",
        stage: "market",
        status: "passed",
        reason: "Market regime regular allowed",
      },
    ],
    blockingReasons: [],
    confirmationReasons: [],
  };
  policy.marketContext = { ...premarketContext, regime: "regular", marketStatus: "regular" };
  return policy;
}

/**
 * Policy pass where the mandate BLOCKED every candidate. EquiRoute then
 * returns `selected: null` while the decision is `blocked` — the case the
 * classifier must still report as `blocked`, not as a bland `unavailable`.
 */
export function policyBlockedFixture(): PolicyResult {
  const policy = policyFixture();
  policy.selected = null;
  policy.marketContext = { ...premarketContext, regime: "closed", marketStatus: "closed" };
  policy.policyDecision = {
    outcome: "blocked",
    checks: [
      {
        id: "market-regime",
        stage: "market",
        status: "failed",
        reason: "Market regime closed is not allowed",
      },
    ],
    blockingReasons: ["Market regime closed is not allowed"],
    confirmationReasons: [],
  };
  return policy;
}

/** No executable route at all: every quote failed upstream, nothing selected. */
export function policyNoRouteFixture(): PolicyResult {
  const policy = policyFixture();
  policy.selected = null;
  policy.quotes = structuredClone([ondoQuote, xstockQuote]) as PolicyResult["quotes"];
  policy.policyRejectedRoutes = [
    {
      provider: "ondo",
      symbol: "NVDAon",
      reasonCode: "POLICY_BLOCKED",
      reason: "Route violates active mandate",
      stage: "representation",
    },
    {
      provider: "xstock",
      symbol: "NVDAx",
      reasonCode: "POLICY_BLOCKED",
      reason: "Route violates active mandate",
      stage: "representation",
    },
  ];
  return policy;
}

export function routeNoRouteFixture(): RouteResult {
  const route = routeFixture();
  route.selected = null;
  route.quotes = structuredClone([ondoQuote, xstockQuote]) as RouteResult["quotes"];
  route.explanation = [
    "No executable route remained after policy filtering and deterministic ranking.",
    "Market regime: premarket.",
  ];
  return route;
}

/** `POST /api/route` 200 for an unsupported ticker (HTTP 200, not 4xx). */
export function routeUnsupportedTickerFixture(ticker: string): RouteResult {
  return {
    intent: { ticker, notionalUsd: "10", userWalletAddress: null },
    marketContext: null,
    representationsEvaluated: 0,
    quotes: [],
    selected: null,
    rejected: [
      {
        provider: null,
        symbol: ticker,
        reason: `Unsupported ticker: ${ticker}`,
        code: "UNSUPPORTED_TICKER",
      },
    ],
    explanation: [`No canonical tokenized representations registered for ${ticker}.`],
  } as RouteResult;
}

/**
 * `POST /api/policy/evaluate` 200 for an unsupported ticker: equiroute's
 * `routeIntent` returns early, so `policyDecision` is ABSENT.
 */
export function policyUnsupportedTickerFixture(ticker: string): PolicyResult {
  return {
    mandate: DEFAULT_MANDATE,
    intent: { ticker, notionalUsd: "10", userWalletAddress: null },
    marketContext: null,
    quotes: [],
    selected: null,
    rejected: [
      {
        provider: null,
        symbol: ticker,
        reason: `Unsupported ticker: ${ticker}`,
        code: "UNSUPPORTED_TICKER",
      },
    ],
    policyRejectedRoutes: [],
    evaluatedAt: "2026-10-08T12:02:27.248Z",
  } as PolicyResult;
}
