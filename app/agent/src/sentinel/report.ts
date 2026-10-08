/**
 * Deterministic Sentinel report builder.
 *
 * FIXED CODE ONLY — no LLM reaches this module. Every field is either copied
 * verbatim from an EquiRoute response or derived by the rule table below.
 * Numbers are carried as the decimal STRINGS EquiRoute produced; nothing is
 * reparsed, rounded, rescaled or recomputed.
 *
 * ## Why two EquiRoute passes are merged
 *
 * `/api/policy/evaluate` is the mandate-aware authority: its `selected` is the
 * compliant winner and its `policyDecision` is the deterministic verdict.
 * But when a quote fails upstream, that pass reports the coarse mandate reason
 * (`POLICY_BLOCKED` / "Route violates active mandate") and LOSES the real cause.
 * `/api/route` keeps the real quote-level reason (e.g. `40001` /
 * "userWalletAddress is required for RFQ (Ondo) quote"), so both are merged and
 * the truest reason wins — without ever editing EquiRoute's strings.
 *
 * ## Opportunity classification (rules, never LLM judgment)
 *
 *   policy blocked               → blocked              (safety first)
 *   policy decision unavailable  → unavailable
 *   no selected representation   → unavailable
 *   policy confirmation_required → needs_confirmation
 *   policy allowed               → actionable
 *
 * `blocked` is evaluated before the no-route check on purpose: when the mandate
 * blocks every candidate EquiRoute returns `selected: null`, and reporting that
 * as a bland "unavailable" would hide the fact that policy refused it.
 */

import type { EquiRouteError } from "./equirouteClient.js";
import type {
  NormalizedQuote,
  OpportunityStatus,
  PolicyResult,
  RouteResult,
  SentinelAlternative,
  SentinelIntent,
  SentinelPolicyOutcome,
  SentinelReport,
  SentinelSelectedRepresentation,
  RejectionClass,
} from "./types.js";

/** Injectable clock so reports are reproducible under test. */
export type Clock = () => Date;

const systemClock: Clock = () => new Date();

function key(provider: string, symbol: string): string {
  return `${provider}:${symbol}`;
}

function nullish(value: string | null | undefined): string | null {
  return value === undefined ? null : value;
}

/** Copy the deterministic winner verbatim. No field is derived or reformatted. */
function toSelectedRepresentation(
  quote: NormalizedQuote,
): SentinelSelectedRepresentation {
  return {
    provider: quote.provider,
    symbol: quote.symbol,
    contractAddress: quote.contractAddress,
    executionMode: nullish(quote.executionMode),
    expectedOutput: nullish(quote.outputTokenAmount),
    normalizedUnderlyingShares: nullish(quote.estimatedUnderlyingShares),
    effectiveUsdPerShare: nullish(quote.effectiveUsdPerShare),
  };
}

interface Rejection {
  reason: string;
  code: string | null;
  stage: string | null;
}

/** Quote-level upstream failures — the truest cause when a quote has none. */
function quoteFailures(quotes: readonly NormalizedQuote[]): Map<string, Rejection> {
  const out = new Map<string, Rejection>();
  for (const quote of quotes) {
    const reason = quote.failureReason;
    if (typeof reason === "string" && reason !== "") {
      out.set(key(quote.provider, quote.symbol), {
        reason,
        code: nullish(quote.failureCode),
        stage: null,
      });
    }
  }
  return out;
}

function routeRejections(route: RouteResult | null): Map<string, Rejection> {
  const out = new Map<string, Rejection>();
  for (const entry of route?.rejected ?? []) {
    if (entry.provider === null) continue;
    out.set(key(entry.provider, entry.symbol), {
      reason: entry.reason,
      code: nullish(entry.code),
      stage: null,
    });
  }
  return out;
}

function policyRejections(policy: PolicyResult | null): Map<string, Rejection> {
  const out = new Map<string, Rejection>();
  for (const entry of policy?.policyRejectedRoutes ?? []) {
    out.set(key(entry.provider, entry.symbol), {
      reason: entry.reason,
      code: entry.reasonCode,
      stage: entry.stage,
    });
  }
  return out;
}

function classifyRejection(rejection: Rejection): RejectionClass {
  if (
    rejection.code === "40001" &&
    /userWalletAddress is required for RFQ/iu.test(rejection.reason)
  ) {
    return "QUOTE_CONTEXT_ADDRESS_REQUIRED";
  }
  if (
    rejection.code === "40374" ||
    /insufficient liquidity|no executable liquidity/iu.test(rejection.reason)
  ) {
    return "NO_EXECUTABLE_LIQUIDITY";
  }
  if (
    rejection.code === "POLICY_BLOCKED" ||
    rejection.code === "PROVIDER_BLOCKED" ||
    rejection.code === "PRICE_IMPACT_LIMIT" ||
    rejection.code === "UNVERIFIED_WRAPPER_RATIO" ||
    rejection.stage !== null
  ) {
    return "POLICY_INELIGIBLE";
  }
  return "QUOTE_FAILED";
}

function rejectionIsIncomplete(rejection: Rejection): boolean {
  return classifyRejection(rejection) === "QUOTE_CONTEXT_ADDRESS_REQUIRED";
}



export interface BuildReportInput {
  readonly intent: SentinelIntent;
  readonly route: RouteResult | null;
  readonly policy: PolicyResult | null;
  readonly quoteContextAddress?: string | null;
  readonly routeError?: EquiRouteError | null;
  readonly policyError?: EquiRouteError | null;
  readonly clock?: Clock;
}


export function buildSentinelReport(input: BuildReportInput): SentinelReport {
  const clock = input.clock ?? systemClock;
  const { intent, route, policy } = input;
  const warnings: string[] = [];

  if (input.routeError) warnings.push(`route discovery: ${input.routeError.describe()}`);
  if (input.policyError) warnings.push(`policy evaluation: ${input.policyError.describe()}`);

  // ── market regime (verbatim from EquiRoute) ────────────────────────────────
  const marketContext = policy?.marketContext ?? route?.marketContext ?? null;
  const regime =
    marketContext === null ? null : (nullish(marketContext.regime) ?? null);
  if (marketContext === null) {
    warnings.push("EquiRoute returned no market context; market regime is unknown.");
  } else if (regime === "unknown") {
    warnings.push(
      "EquiRoute reported market regime 'unknown' (underlying market data unavailable).",
    );
  }

  // ── selected representation ────────────────────────────────────────────────
  // The mandate-aware pass is authoritative. The unconstrained route pass is a
  // documented fallback and is flagged, because it is NOT mandate-filtered.
  let selectedQuote: NormalizedQuote | null = policy?.selected ?? null;
  if (selectedQuote === null && policy === null && route?.selected) {
    selectedQuote = route.selected;
    warnings.push(
      "Selected representation came from unconstrained route discovery; the " +
        "mandate was NOT evaluated for it.",
    );
  }
  if (policy !== null && route === null) {
    warnings.push(
      "Route discovery was unavailable; the unconstrained candidate view is " +
        "missing (quote-level causes are still taken from the policy pass).",
    );
  }

  // The two passes each fetch their own live quotes, so they can disagree.
  // When route discovery quoted a winner but the mandate pass had none, the
  // cause is usually a TRANSIENT upstream quote failure in the mandate pass —
  // not the mandate. Say so, rather than letting `POLICY_BLOCKED` imply a
  // policy rejection that did not really happen.
  if (
    policy !== null &&
    policy.selected === null &&
    route?.selected != null &&
    (policy.policyDecision?.blockingReasons.length ?? 0) === 0
  ) {
    warnings.push(
      `Route discovery quoted ${route.selected.provider}/${route.selected.symbol} ` +
        "but the mandate-evaluation pass returned no selectable route, and the " +
        "mandate raised no blocking reason. This usually means a transient " +
        "upstream quote failure in that pass rather than a policy rejection; " +
        "re-run before drawing conclusions.",
    );
  }

  // ── alternatives (every non-selected candidate, reasons preserved) ─────────
  const candidates: readonly NormalizedQuote[] =
    (policy?.quotes.length ?? 0) > 0
      ? (policy?.quotes ?? [])
      : (route?.quotes ?? []);

  const policyRejected = policyRejections(policy);
  const policyRejectedKeys = new Set(policyRejected.keys());
  const fromQuote = quoteFailures(
    (route?.quotes.length ?? 0) > 0 ? (route?.quotes ?? []) : candidates,
  );
  const fromRoute = routeRejections(route);
  const selectedKey =
    selectedQuote === null ? null : key(selectedQuote.provider, selectedQuote.symbol);

  const alternatives: SentinelAlternative[] = [];
  for (const quote of candidates) {
    const candidateKey = key(quote.provider, quote.symbol);
    if (candidateKey === selectedKey) continue;

    // A quote-level failure is NOT a mandate rejection, even though EquiRoute
    // can also list it in policyRejectedRoutes as `POLICY_BLOCKED` because the
    // quote was unavailable. Only mark a quote as policy-ineligible if it
    // actually returned a quote and the mandate rejected that representation.
    const hasQuoteFailure =
      typeof quote.failureReason === "string" && quote.failureReason !== "";
    const policyExcluded = policyRejectedKeys.has(candidateKey) && !hasQuoteFailure;
    const eligible = quote.available === true && !policyExcluded;
    const alternative: SentinelAlternative = {
      provider: quote.provider,
      symbol: quote.symbol,
      eligible,
      normalizedUnderlyingShares: nullish(quote.estimatedUnderlyingShares),
      effectiveUsdPerShare: nullish(quote.effectiveUsdPerShare),
    };

    // Truest cause first; EquiRoute's strings are never edited or merged.
    const rejection =
      fromQuote.get(candidateKey) ??
      fromRoute.get(candidateKey) ??
      (policyExcluded ? policyRejected.get(candidateKey) : undefined) ??
      null;
    if (!eligible && rejection !== null) {
      alternative.rejectionReason = rejection.reason;
      alternative.rejectionCode = rejection.code;
      alternative.rejectionClass = classifyRejection(rejection);
      if (rejection.stage !== null) alternative.rejectionStage = rejection.stage;
    }
    alternatives.push(alternative);
  }

  // Ticker-level rejections (e.g. UNSUPPORTED_TICKER) carry no provider and so
  // are not candidates — surface them as warnings rather than dropping them.
  for (const entry of route?.rejected ?? []) {
    if (entry.provider === null) {
      warnings.push(`EquiRoute rejected the request: ${entry.reason}`);
    }
  }

  // ── deterministic policy verdict (verbatim, never inferred) ────────────────
  const decision = policy?.policyDecision;
  const outcome: SentinelPolicyOutcome = decision?.outcome ?? "unavailable";
  const blockingReasons = [...(decision?.blockingReasons ?? [])];
  const confirmationReasons = [...(decision?.confirmationReasons ?? [])];
  if (decision === undefined && policy !== null && input.policyError == null) {
    warnings.push(
      "EquiRoute returned no policy decision for this request; no policy " +
        "outcome is inferred.",
    );
  }

  const opportunity = classifyOpportunity({
    outcome,
    hasSelected: selectedQuote !== null,
    blockingReasons,
    confirmationReasons,
    failure: input.policyError ?? input.routeError ?? null,
  });

  const quoteContextAddress = input.quoteContextAddress ?? null;
  const incompleteCandidates = alternatives.filter(
    (alternative) => alternative.rejectionClass === "QUOTE_CONTEXT_ADDRESS_REQUIRED",
  );
  const technicalFailures = alternatives.filter(
    (alternative) =>
      alternative.rejectionClass === "QUOTE_FAILED" ||
      alternative.rejectionClass === "QUOTE_CONTEXT_ADDRESS_REQUIRED",
  );
  const unavailableTicker = (route?.rejected ?? []).some(
    (entry) => entry.code === "UNSUPPORTED_TICKER",
  );
  const totalRepresentations = Math.max(
    route?.representationsEvaluated ?? 0,
    policy?.quotes.length ?? 0,
    route?.quotes.length ?? 0,
  );
  const evaluatedRepresentations = Math.max(
    route?.quotes.length ?? 0,
    policy?.quotes.length ?? 0,
  );
  const unavailableRepresentations = candidates.filter(
    (quote) => quote.available !== true,
  ).length;
  const comparableCandidateCount = candidates.filter(
    (quote) => quote.available === true,
  ).length;
  const unavailableBy = alternatives
    .filter((alternative) => alternative.rejectionClass === "NO_EXECUTABLE_LIQUIDITY")
    .map(
      (alternative) =>
        `${alternative.provider}/${alternative.symbol}: ${alternative.rejectionClass}`,
    );
  const degradedBy = technicalFailures.map(
    (alternative) =>
      `${alternative.provider}/${alternative.symbol}: ${alternative.rejectionClass}`,
  );
  const report: SentinelReport = {
    version: "1",
    generatedAt: clock().toISOString(),
    intent: {
      ticker: intent.ticker,
      notionalUsd: intent.notionalUsd,
      slippagePercent: intent.slippagePercent,
    },
    market: { regime, available: marketContext !== null },
    selectedRepresentation:
      selectedQuote === null ? null : toSelectedRepresentation(selectedQuote),
    alternatives,
    quoteContext: {
      addressUsed: quoteContextAddress,
      purpose: "read_only_quote_context",
      executionAuthority: false,
    },
    comparison: {
      status: technicalFailures.length > 0 || unavailableTicker ? "degraded" : "complete",
      totalRepresentations,
      evaluatedRepresentations,
      economicallyComparableRepresentations: Math.max(
        0,
        comparableCandidateCount,
      ),
      unavailableRepresentations,
      unavailableBy,
      degradedBy,
    },
    policy: { outcome, blockingReasons, confirmationReasons },
    opportunity,
    // INVARIANT — constant on every report, on every face, always.
    execution: { authorization: "none", requiresUserReviewInEquiRoute: true },
    warnings,
  };
  return report;
}

interface ClassifyInput {
  readonly outcome: SentinelPolicyOutcome;
  readonly hasSelected: boolean;
  readonly blockingReasons: readonly string[];
  readonly confirmationReasons: readonly string[];
  readonly failure: EquiRouteError | null;
}

/**
 * Translate EquiRoute's deterministic result into a monitoring status.
 *
 * Pure rule table over the policy outcome and route presence. The LLM may
 * explain the result of this function; it can never influence it.
 */
export function classifyOpportunity(input: ClassifyInput): {
  status: OpportunityStatus;
  reason: string;
} {
  if (input.outcome === "blocked") {
    return {
      status: "blocked",
      reason:
        input.blockingReasons.length > 0
          ? `EquiRoute policy blocked this request: ${input.blockingReasons.join("; ")}`
          : "EquiRoute policy blocked this request.",
    };
  }
  if (input.outcome === "unavailable") {
    return {
      status: "unavailable",
      reason:
        input.failure !== null
          ? `No deterministic EquiRoute result is available. ${input.failure.describe()}`
          : "EquiRoute returned no deterministic policy decision for this request.",
    };
  }
  if (!input.hasSelected) {
    return {
      status: "unavailable",
      reason:
        "EquiRoute selected no executable representation for this request, so " +
        "there is no opportunity to act on.",
    };
  }
  if (input.outcome === "confirmation_required") {
    return {
      status: "needs_confirmation",
      reason:
        input.confirmationReasons.length > 0
          ? `EquiRoute policy requires human confirmation: ${input.confirmationReasons.join("; ")}`
          : "EquiRoute policy requires human confirmation.",
    };
  }
  return {
    status: "actionable",
    reason:
      "EquiRoute policy allowed this request against the active mandate. " +
      "Review it in EquiRoute to execute.",
  };
}

/**
 * Safe report for a request that never reached a usable EquiRoute result.
 *
 * Deliberately contains NO representation, NO quote and NO policy outcome: an
 * unavailable EquiRoute must never produce a fabricated opportunity.
 */
export function buildUnavailableReport(
  intent: SentinelIntent,
  reason: string,
  clock: Clock = systemClock,
): SentinelReport {
  return {
    version: "1",
    generatedAt: clock().toISOString(),
    intent: {
      ticker: intent.ticker,
      notionalUsd: intent.notionalUsd,
      slippagePercent: intent.slippagePercent,
    },
    market: { regime: null, available: false },
    selectedRepresentation: null,
    alternatives: [],
    quoteContext: {
      addressUsed: null,
      purpose: "read_only_quote_context",
      executionAuthority: false,
    },
    comparison: {
      status: "degraded",
      totalRepresentations: 0,
      evaluatedRepresentations: 0,
      economicallyComparableRepresentations: 0,
      unavailableRepresentations: 0,
      unavailableBy: [],
      degradedBy: [],
    },
    policy: { outcome: "unavailable", blockingReasons: [], confirmationReasons: [] },
    opportunity: { status: "unavailable", reason },
    execution: { authorization: "none", requiresUserReviewInEquiRoute: true },
    warnings: [reason],
  };
}
